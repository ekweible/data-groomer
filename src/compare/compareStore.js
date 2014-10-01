// libs
var Reflux = require('reflux');

// application imports
var compareActions = require('./compareActions');


module.exports = Reflux.createStore({
    listenables: compareActions,

    init: function() {
        this.comparison = {};
    },

    onSetResults: function(comparison) {
        this.comparison = comparison;
        this.trigger(this.comparison);
    }
});
