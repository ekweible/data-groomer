var AppRoutes = require('./components/AppRoutes');
var React = require('react');

(function init() {
    var mountNode = document.getElementById('app');
    React.renderComponent(new AppRoutes(null), mountNode);
})();
