/**
 * Copyright 2015 IBM Corp.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 **/

'use strict';

// core dependencies
var util = require('util');

// external dependencies
var _ = require('lodash');
var async = require('async');
var httpstatus = require('http-status');
var makeArray = require('make-array');
var cache = require('memory-cache');
var uuid = require('node-uuid');

// local dependencies
var restutils = require('../../components/restutils');
var db = require('../../config/db/store');
var dberrors = require('../../config/db/errors');
var log = require('../../config/log');
var socketUtil = require('../../config/socket');

var responses = restutils.res;
var requests = restutils.req;

var MINUTE = 1000 * 60;
var HOUR = 60 * MINUTE;

var STATUS = {
  RUNNING : 'running',
  COMPLETE : 'complete',
  ERROR : 'error'
};

/**
 * Constructor for a new Error object specific to database patch operations
 *
 * @param {Error} databaseError - root error
 * @param {Object} operation - patch operation
 * @returns {void} this is a constructor meant to be called via 'new'
 */
function PatchError (databaseError, operation) {
    dberrors.DatabaseError.call(this, databaseError.category, databaseError.message, databaseError.code); //super constructor
    Error.captureStackTrace(this, this.constructor);
    this.operation = operation;
}
util.inherits(PatchError, dberrors.DatabaseError);

function sanitizeMetadata (value) {
  if (value && (value.value || value.metadata) ) {
    var patch = {
      value : value.value,
      metadata : value.metadata
    };
    return patch;
  }
  return null;
}

function getClassesToPatch (values) {
  return values.map(function getIds (cls) {
    if (cls && (typeof cls.id === 'string' || cls.id instanceof String)) {
      return cls.id;
    }
  }).filter(function makeDense (mapped) {
    if (mapped) {
      return true;
    }
  });
}

function patchTextClasses (tenantid, textid, patchoperation, callback) {
  switch (patchoperation.op) {
    case 'add':
      log.debug({
        operation : patchoperation,
        text : textid
      }, 'Adding classes to text');
      var tenantsToAdd = getClassesToPatch(patchoperation.value);
      if (tenantsToAdd.length !== patchoperation.value.length) {
        return callback(dberrors.invalid('Invalid value array'));
      }
      db.addClassesToText(tenantid, textid, tenantsToAdd, callback);
      break;
    case 'remove':
      log.debug({
        operation : patchoperation,
        text : textid
      }, 'Removing classes from text');
      var tenantsToRemove = getClassesToPatch(patchoperation.value);
      if (tenantsToRemove.length !== patchoperation.value.length) {
        return callback(dberrors.invalid('Invalid value array'));
      }

      db.removeClassesFromText(tenantid, textid, tenantsToRemove, callback);
      break;
    default:
      log.debug({
        operation : patchoperation
      }, 'Unsupported operation');
      return callback(dberrors.invalid('Unsupported operation'));
  }
}

function patchTextMetadata (tenantid, textid, patchoperation, callback) {
  switch (patchoperation.op) {
    case 'replace':
      log.debug({
        operation : patchoperation,
        text : textid
      }, 'Updating metadata on text');
      var metadata = sanitizeMetadata(patchoperation.value);
      if (!metadata) {
        return callback(dberrors.invalid('Invalid value'));
      }
      db.updateTextMetadata(tenantid, textid, metadata, callback);
      break;
    default:
      log.debug({
        operation : patchoperation
      }, 'Unsupported operation');
      return callback(dberrors.invalid('Unsupported operation'));
  }
}

module.exports.getTexts = function getTexts (req, res) {
  log.debug({
    params : req.params,
    query : req.query
  }, 'Getting texts');

  var tenantid = req.params.tenantid;
  var options = requests.listoptions(req);

  async.parallel([
    function getBatch (next) {
      db.getTexts(tenantid, options, next);
    },
    function getCount (next) {
      db.countTexts(tenantid, next);
    }
  ], function returnTexts (err, textresults) {
    if (err) {
      return responses.error(res, err);
    }
    var texts = textresults[0];
    var count = textresults[1];

    log.debug({
      tenant : tenantid,
      num : count
    }, 'Got texts');

    responses.batch(texts, options.skip, count, res);
  });
};

module.exports.getText = function getText (req, res) {
  log.debug({params : req.params}, 'Getting text');

  var tenantid = req.params.tenantid;
  var textid = req.params.textid;

  db.getText(tenantid, textid, function returnClass (err, text) {
    if (err) {
      return dberrors.handle(err, [httpstatus.NOT_FOUND], 'Error occurred while attempting to retrieve class.', function returnResponse () {
        return responses.error(res, err);
      });
    }
    responses.item(text, res);
  });
};

module.exports.createText = function createText (req, res) {
  log.debug({ body : req.body, params : req.params }, 'Creating text');

  var tenantid = req.params.tenantid;
  var textattrs = req.body;

  if (!textattrs || !Object.keys(textattrs).length) {
    return responses.badrequest('Missing request body', res);
  }

  db.createText(tenantid, textattrs, function returnNewTest (err, text) {
    if (err) {
      socketUtil.send('text:create', { attributes : textattrs, err : err });
      return dberrors.handle(err, [httpstatus.BAD_REQUEST], 'Error occurred while attempting to create text.', function returnResponse () {
        return responses.error(res, err);
      });
    }

    text.id = text._id;
    delete text._id;
    log.debug({ text : text }, 'Created text');

    socketUtil.send('text:create', { attributes : text });
    responses.newitem(
      text,
      req.baseUrl + req.route.path, {
        ':tenantid' : tenantid,
        ':textid' : text.id
      },
      res);
  });
};

function operationHandler (patchoperation, patchid, patchdetails, callback) {
  return function handleResult (err, result) {
    var output = result;
    if (err) {
      log.debug(err, 'Patch error: ' + JSON.stringify(patchoperation));
      patchdetails.error++;
      output = new PatchError(err, patchoperation);
    } else {
      patchdetails.success++;
      output = result;
    }

    cache.put(patchid, patchdetails, 5 * MINUTE);
    return callback(null, output);
  };
}

function socketMessageNameBuilder (operation) {
  var name = '';
  if (operation && operation.path && (typeof operation.path === 'string' || operation.path instanceof String)) {
    name += (operation.path[0] === '/' ? operation.path.substring(1) : operation.path);
  } else {
    name += 'unknown';
  }

  name += ':';

  if (operation && operation.op) {
    name += operation.op;
  } else {
    name += 'unknown';
  }

  return name;
}

function socketResponseBuilder (textid, data) {
  var response = {};
  response.id = textid;
  if (data instanceof PatchError) {
    response.error = data;

    // metadata patch
    if (_.has(data, 'operation.value.value')) {
      response.value = data.operation.value.value;
    }
    // classes path
    else if (_.has(data, 'operation.value')) {
      response.classes = data.operation.value;
    }
  } else if (data.classes && data.classes.length) {
    response.classes = data.classes;
  } else if (_.has(data, 'metadata.value')) {
    response.value = data.metadata.value;
  } else {
    return null;
  }

  return response;
}

module.exports.editText = function editText (req, res) {
  log.debug({
    body : req.body,
    params : req.params
  }, 'Patching text');

  var tenantid = req.params.tenantid;
  var textid = req.params.textid;

  var patchoperations = requests.verifyObjectsList(makeArray(req.body));

  var details = {
      status : STATUS.RUNNING,
      success : 0,
      error : 0
  };

  var patchid = uuid.v1();

  cache.put(patchid, details, 5 * MINUTE);

  async.mapLimit(patchoperations, 10, function applyPatch (patchoperation, nextop) {
    var getCallback = function getCallback () {
      return operationHandler(patchoperation, patchid, details, nextop);
    };

    if (patchoperation.path === '/classes') {
      return patchTextClasses(tenantid, textid, patchoperation, getCallback());
    } else if (patchoperation.path === '/metadata') {
      return patchTextMetadata(tenantid, textid, patchoperation, getCallback());
    } else {
      log.debug({operation : patchoperation}, 'Unsupported operation');
      details.error++;
      return nextop(null, new PatchError(dberrors.invalid('Unsupported operation'), patchoperation));
    }
  }, function handlePatchResponse (err, data) {

    if (err) {
      details.status = STATUS.ERROR;
    } else {
      details.status = STATUS.COMPLETE;
    }

    cache.put(patchid, details, 5 * MINUTE);

    data.forEach(function forEach (result) {
      var response = socketResponseBuilder(textid, result);
      if (response !== null) {
        socketUtil.send('text:update:' + socketMessageNameBuilder(result.operation), response);
      }
    });
  });

  responses.accepted(
    req.baseUrl + req.route.path + '/patch/:patchid',
    {
      ':tenantid' : tenantid,
      ':textid' : textid,
      ':patchid' : patchid
    },
    res);
};

module.exports.deleteText = function deleteText (req, res) {
  log.debug({params : req.params}, 'Deleting text');

  var tenantid = req.params.tenantid;
  var textid = req.params.textid;
  var etag = req.headers['if-match'];

  if (!etag) {
    return responses.missingEtag(res);
  }

  db.deleteText(tenantid, textid, etag, function deletedText (err) {
    if (err) {
      socketUtil.send('text:delete', { id : textid, err : err });
      return dberrors.handle(err, [httpstatus.NOT_FOUND], 'Error occurred while attempting to delete text.', function returnResponse () {
        return responses.error(res, err);
      });
    }

    log.debug({text : textid}, 'Deleted text');
    socketUtil.send('text:delete', { id : textid });
    responses.del(res);
  });
};

module.exports.deleteTexts = function deleteTexts (req, res) {
  log.debug({params : req.params}, 'Deleting text');

  var tenantid = req.params.tenantid;
  var ids = req.body;
  var etag = req.headers['if-match'];

  if (!etag) {
    return responses.missingEtag(res);
  }

  ids.forEach(function forEach (textid) {
    db.deleteText(tenantid, textid, etag, function deletedText (err) {
      if (err) {
        socketUtil.send('text:delete', { id : textid, err : err });
        return dberrors.handle(err, [httpstatus.NOT_FOUND], 'Error occurred while attempting to delete text.', function returnResponse () {
          return responses.error(res, err);
        });
      }
      log.debug({text : textid}, 'Deleted text');
      socketUtil.send('text:delete', { id : textid });
    });
  });
  responses.del(res);
};

module.exports.patchStatus = function patchStatus (req, res) {
  var tenantid = req.params.tenantid;
  var patchid = req.params.patchid;

  var details = cache.get(patchid);
  if (details) {
    return res.status(httpstatus.OK)
      .json(details);
  }

  return responses.notfound(res);
}
