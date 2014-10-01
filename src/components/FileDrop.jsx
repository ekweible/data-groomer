// lib
var React = require('react');

// application
var dataFileActions = require('../dataFiles/dataFileActions');
var dataFileService = require('../dataFiles/dataFileService');


/**
 * File drop upload component.
 */
var FileDrop = module.exports = React.createClass({
    displayName: 'FileDrop',

    getInitialState: function() {
        return {
            over: false
        };
    },

    dragOver: function(e) {
        e.stopPropagation();
        e.preventDefault();
        this.setState({over: true});
    },

    dragLeave: function(e) {
        this.setState({over: false});
    },

    drop: function(e) {
        // prevent drop event from propagating to browser
        e.stopPropagation();
        e.preventDefault();

        // remove hover state
        this.setState({over: false});

        // grab all dropped files
        var droppedFiles = e.target.files || e.dataTransfer.files;

        // upload progress handler
        var onProgress = function(percentComplete) {
            console.log(percentComplete);
        };

        // start the upload
        dataFileService.upload(droppedFiles, onProgress).then(function(dataFiles) {
            dataFileActions.add(dataFiles);
        }, function(error) {
            console.error(error);
        });
    },

    render: function() {
        var fileDropClass = 'target';
        if (this.state.over) {
            fileDropClass += ' over';
        }

        return (
            <div className="file-upload">
                <p className={fileDropClass}
                   onDragOver={this.dragOver}
                   onDragLeave={this.dragLeave}
                   onDrop={this.drop}>
                    Drop Files Here
                </p>
            </div>
        );
    }
});
