# lib imports
import webapp2

# app imports
from py.frontend.handlers import AppHandler


ROUTES = [
    webapp2.Route(r'/<:.*>', handler=AppHandler, name='app'),
]

app = webapp2.WSGIApplication(ROUTES, debug=True)
