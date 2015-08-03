'use strict';

// Production specific configuration
// =================================
var cfenv = require('cfenv');
var appEnv = cfenv.getAppEnv();
var bluemix = require('../bluemix');
module.exports = {
    // Server IP
    ip: appEnv.bind ||
        process.env.OPENSHIFT_NODEJS_IP ||
        process.env.IP ||
        undefined,

    // Server port
    port:   appEnv.port ||
            process.env.OPENSHIFT_NODEJS_PORT ||
            process.env.PORT ||
            8080,

    nlc_credentials: bluemix.getServiceCreds('natural_language_classifier')
    
};
