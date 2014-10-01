var camelCase = require('camel-case');

/**
 * Utilities
 */
var util = module.exports = {};

/**
 * CamelCase all object keys. Given an object, return an object with all keys
 * converted to camelCase. Values will be identical.
 */
util.camelCaseObject = function(obj) {
    if (obj instanceof Array || typeof obj !== 'object') {
        return obj;
    }

    var camelCasedObj = {};
    for (var key in obj) {
        if (obj.hasOwnProperty(key)) {
            camelCasedObj[camelCase(key)] = util.camelCaseObject(obj[key]);
        }
    }

    return camelCasedObj;
};
