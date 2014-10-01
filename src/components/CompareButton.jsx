// lib
var React = require('react');
var Reflux = require('reflux');

// application
var compareActions = require('../compare/compareActions');
var compareService = require('../compare/compareService');
var dataFileStore = require('../dataFiles/dataFileStore');


var CompareButton = module.exports = React.createClass({
    displayName: 'CompareButton',

    mixins: [Reflux.ListenerMixin],

    getInitialState: function() {
        return {
            dataFileIds: [],
            comparisonInProgress: false
        };
    },

    componentDidMount: function() {
        this.listenTo(dataFileStore, this.onDataFileStoreUpdate);
    },

    onDataFileStoreUpdate: function(dataFiles) {
        this.setState({
            dataFileIds: Object.keys(dataFiles)
        });
    },

    handleClick: function() {
        var self = this;

        if (!this.state.dataFileIds.length) {
            return;
        }

        this.setState({
            comparisonInProgress: true
        });
        compareService.runComparisonOn(this.state.dataFileIds).then(function(results) {
            console.log(results);
            self.setState({
                comparisonInProgress: false
            });
            compareActions.setResults(results);
        });
    },

    render: function() {
        var btnDisabled = (!this.state.dataFileIds.length || this.state.comparisonInProgress);
        var btnText = this.state.comparisonInProgress ? 'Running comparison...' : 'Compare';
        var btnClass = 'btn primary';
        if (btnDisabled) {
            btnClass += ' disabled';
        }

        return (
            <div className="compare-action">
                <button type="button" className={btnClass} disabled={btnDisabled} onClick={this.handleClick}>
                    {btnText}
                </button>
            </div>
        );
    }
});
