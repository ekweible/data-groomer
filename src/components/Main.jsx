// reactjs
var React = require('react');

// react-router
var Link = require('react-router').Link;


var Main = module.exports = React.createClass({
    displayName: 'Main',

    render: function() {
        return (
            <div className="main">
                <p className="lead">What do you need me to do?</p>

                <ul className="menu">
                    <li><Link to="compare"><p>Compare CSV Files</p></Link></li>
                </ul>
            </div>
        );
    }
});
