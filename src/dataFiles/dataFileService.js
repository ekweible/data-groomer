/* global dgGlobal */
/* global console */
var ES6Promise = require('es6-promise').Promise;
var transport = require('../services/transport');

// endpoint for data file entities
var DATA_FILES_URL = '/files/data_files/';

// blob upload URL (changes with each use)
var blobUploadUrl = dgGlobal.blobUploadURL;

/**
 * Files Service
 */
var dataFileService = module.exports = {};

/**
 * Upload a list of File objects.
 */
dataFileService.upload = function(fileList, progressCallback) {
    return new ES6Promise(function(resolve, reject) {
        // construct the form data to send over XHR
        var formData = new FormData();
        for (var i = 0; i < fileList.length; i++) {
            formData.append('file[]', fileList[i]);
        }

        // start the upload
        transport.send(blobUploadUrl, 'post', formData, progressCallback).then(function(response) {
            // store the new blob upload URL
            if (response && response.nextBlobUploadUrl) {
                blobUploadUrl = response.nextBlobUploadUrl;
            }

            // check response
            if (response && response.data && response.data.dataFileIds) {
                // use data file IDs to get actual data file entities
                dataFileService.get(response.data.dataFileIds).then(resolve, reject);
            } else {
                // unexpected response
                reject(new Error('Invalid response: ' + response));
            }
        }, function(error) {
            console.error(error);
            reject(error);
        });
    });
};

/**
 * Get dataFile entities by IDs.
 */
dataFileService.get = function(dataFileIds) {
    return new ES6Promise(function(resolve, reject) {
        // build url to GET data files
        var url = DATA_FILES_URL + '?';
        var queryStr = dataFileIds.map(function(id) {
            return 'id=' + id;
        }).join('&');
        url += queryStr;

        // send GET request
        transport.send(url, 'get').then(function(response) {
            if (response && response.data && response.data.dataFiles) {
                // retrieved data file entities
                resolve(response.data.dataFiles);
            } else {
                // unexpected response
                reject(new Error('Invalid response: ' + response));
            }
        }, function(error) {
            console.error(error);
        });
    });
};

/**
 * Get a single dataFile entity.
 */
dataFileService.getSingle = function(dataFileId) {
    return new ES6Promise(function(resolve, reject) {
        dataFileService.get([dataFileId]).then(function(dataFiles) {
            resolve(dataFiles[0]);
        }, reject);
    });
};
