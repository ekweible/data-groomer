// lib
var React = require('react');
var Reflux = require('reflux');

// application
var compareStore = require('../compare/compareStore');
var dataFileStore = require('../dataFiles/dataFileStore');


var ComparisonResults = module.exports = React.createClass({
    displayName: 'ComparisonResults',

    mixins: [Reflux.connect(dataFileStore, 'dataFiles'), Reflux.connect(compareStore, 'discrepancies')],

    getInitialState: function() {
        return {
            dataFiles: {},
            discrepancies: {}
        };
    },

    render: function() {
        var self = this;

        var dataFileKeys = Object.keys(this.state.discrepancies);
        if (!dataFileKeys.length) {
            return null;
        }

        function getDiscrepancyRows(dataFileId) {
            var rowNodes = [];
            Object.keys(self.state.discrepancies[dataFileId]).forEach(function(key) {
                var cols = self.state.discrepancies[dataFileId][key].map(function(val) {
                    return <td>{val}</td>;
                });
                rowNodes.push((
                    <tr key={key}>
                        <td className="row-num">{key}</td>
                        {cols}
                    </tr>
                ));
            });
            return rowNodes;
        }

        var colClass = 'col col-1-' + dataFileKeys.length;
        var comparisonNodes = [];
        dataFileKeys.forEach(function(key) {
            comparisonNodes.push((
                <div className={colClass} key={key}>
                    <h2>{self.state.dataFiles[key].filename}</h2>
                    <table>
                        {getDiscrepancyRows(key)}
                    </table>
                </div>
            ));
        });

        return (
            <div className="comparison-results row">
                {comparisonNodes}
            </div>
        );
    }
});
