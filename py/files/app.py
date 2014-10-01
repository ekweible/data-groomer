# lib imports
import webapp2

# app imports
from py.files.handlers import CompareCSV
from py.files.handlers import DataFiles
from py.files.handlers import UploadFiles


ROUTES = [
    webapp2.Route(r'/files/upload', handler=UploadFiles, name='upload'),
    webapp2.Route(r'/files/data_files/', handler=DataFiles, name='dataFiles'),
    webapp2.Route(r'/files/csv/compare', handler=CompareCSV, name='compare'),
]

app = webapp2.WSGIApplication(ROUTES, debug=True)
