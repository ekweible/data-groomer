// libs
var Reflux = require('reflux');

// application imports
var dataFileActions = require('./dataFileActions');


module.exports = Reflux.createStore({
    listenables: dataFileActions,

    init: function() {
        this.dataFiles = {};
    },

    onAdd: function(dataFiles) {
        for (var i = 0; i < dataFiles.length; i++) {
            this.dataFiles[dataFiles[i].id] = dataFiles[i];
        }
        this.trigger(this.dataFiles);
    }
});
