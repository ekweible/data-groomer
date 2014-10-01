/* global console */
// lib
var ES6Promise = require('es6-promise').Promise;

// application
var transport = require('../services/transport');

// endpoint for running a data file comparison
var DATA_FILE_COMPARISON_URL = '/files/csv/compare';


/**
 * Data File Comparison Service.
 */
var compareService = module.exports = {};

/**
 * Send a request to the server to run a data file comparison
 * on the data file entities specified by the given data file IDs.
 */
compareService.runComparisonOn = function(dataFileIds) {
    return new ES6Promise(function(resolve, reject) {
        var url = DATA_FILE_COMPARISON_URL + '?';
        var queryStr = dataFileIds.map(function(id) {
            return 'id=' + id;
        }).join('&');
        url += queryStr;

        transport.send(url, 'get').then(function(response) {
            // check response
            if (response && response.data && response.data.comparison) {
                resolve(response.data.comparison);
            } else {
                // unexpected response
                reject(response);
            }
        }, function(error) {
            console.error(error);
            reject(error);
        });
    });
};
