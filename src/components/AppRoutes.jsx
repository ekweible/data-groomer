// reactjs
var React = require('react');

// react-router
var DefaultRoute = require('react-router').DefaultRoute;
var NotFoundRoute = require('react-router').NotFoundRoute;
var Route = require('react-router').Route;
var Routes = require('react-router').Routes;

// application
var App = require('./App');
var Compare = require('./Compare');
var Main = require('./Main');
var NotFound = require('./NotFound');


var AppRoutes = module.exports = React.createClass({
    displayName: 'DataGroomerAppRoutes',

    render: function() {
        return (
            <Routes location="history">
                <Route path="/" handler={App}>
                    <DefaultRoute handler={Main} />
                    <Route name="compare" handler={Compare} />
                </Route>
                <NotFoundRoute handler={NotFound} />
            </Routes>
        );
    }
});
