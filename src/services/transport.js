var ES6Promise = require('es6-promise').Promise;
var util = require('../util');

/**
 * Transport Servie.
 */
var transport = module.exports = {};

/**
 * Send a request.
 */
transport.send = function(url, method, data, progressCallback) {
    return new ES6Promise(function(resolve, reject) {
        try {
            // create a new XHR request
            var req = new XMLHttpRequest();
            req.open(method, url, true);

            // progress listener
            if (typeof progressCallback !== 'undefined') {
                req.upload.onprogress = function(event) {
                    if (event.lengthComputable) {
                        var percentComplete = event.loaded / event.total;
                        progressCallback(percentComplete);
                    }
                };
            }

            // completion handler
            req.onload = function() {
                if (req.status === 200) {
                    resolve(transport.parseResponse(req.response));
                } else {
                    reject(new Error(req.statusText));
                }
            };

            // error handler
            req.onerror = function() {
                reject(Error('Network error'));
            };

            // send the request
            req.send(data);
        } catch (e) {
            reject(e);
        }
    });
};

/**
 * Parse a response. Convert to JSON and convert snake_case to camelCase.
 */
transport.parseResponse = function(response) {
    try {
        response = JSON.parse(response);
    } catch (e) {
        throw new Error('Could not parse response into JSON: ' + response);
    }

    return util.camelCaseObject(response);
};
