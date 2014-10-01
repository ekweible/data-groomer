# gae imports
from google.appengine.ext import blobstore

# lib imports
import webapp2

# application imports
from py.frontend.template import get_environment


CONTENT_TYPE_HEADER = 'Content-Type'
CONTENT_TYPE_HTML = 'text/html'


class AppHandler(webapp2.RequestHandler):
    template = 'main.html'

    def get(self, path):
        template = get_environment().get_template(self.template)
        context = {
            'upload_url': blobstore.create_upload_url('/files/upload')
        }

        self.response.headers[CONTENT_TYPE_HEADER] = CONTENT_TYPE_HTML
        self.response.write(template.render(context))
