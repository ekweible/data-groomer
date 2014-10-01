// lib
var React = require('react');

// components
var CompareButton = require('./CompareButton');
var ComparisonResults = require('./ComparisonResults');
var DataFileList = require('./DataFileList');
var DataFileUploadStatus = require('./DataFileUploadStatus');
var FileDrop = require('./FileDrop');

/**
 * React component for the "Compare" view.
 */
var Compare = module.exports = React.createClass({
    displayName: 'Compare',

    render: function() {
        return (
            <div className="compare">
                <p className="lead">Compare CSV files by dropping them onto the page below</p>
                <DataFileList />
                <DataFileUploadStatus />
                <CompareButton />
                <ComparisonResults />
                <FileDrop />
            </div>
        );
    }
});
