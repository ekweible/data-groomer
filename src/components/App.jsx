// reactjs
var React = require('react');

// react-router
var Link = require('react-router').Link;


var App = module.exports = React.createClass({
    displayName: 'DataGroomerApp',

    render: function() {
        return (
            <div>
                <div className="container header">
                    <h1><Link to="/">DataGroomer</Link></h1>
                </div>

                <div className="container content">
                    <this.props.activeRouteHandler />
                </div>
            </div>
        );
    }
});
