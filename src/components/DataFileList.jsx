// lib
var React = require('react');
var Reflux = require('reflux');

// application
var dataFileStore = require('../dataFiles/dataFileStore');


/**
 * React component for rendering a list of active data files.
 */
var DataFileList = module.exports = React.createClass({
    displayName: 'DataFileList',

    mixins: [Reflux.connect(dataFileStore, 'dataFiles')],

    getInitialState: function() {
        return {
            dataFiles: {}
        };
    },

    buildDataFileList: function(dataFiles) {
        var dataFileList = [];
        Object.keys(dataFiles).forEach(function(key) {
            dataFileList.push(dataFiles[key]);
        });
        return dataFileList;
    },

    onDataFileStoreUpdate: function(dataFiles) {
        this.setState({
            dataFiles: dataFiles
        });
    },

    render: function() {
        var dataFileList = this.buildDataFileList(this.state.dataFiles);
        var dataFileListNodes = [];
        for (var i = 0; i < dataFileList.length; i++) {
            dataFileListNodes.push(<li key={dataFileList[i].id}>{dataFileList[i].filename}</li>);
        }

        return (
            <ul className="data-file-list">
                {dataFileListNodes}
            </ul>
        );
    }
});
