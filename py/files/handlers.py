# gae imports
from google.appengine.ext import blobstore
from google.appengine.ext import ndb
from google.appengine.ext.webapp import blobstore_handlers

# lib imports
import csv
import json
import urllib2
import webapp2

# app imports
from py.blob.util import BlobIterator
from py.groomer.csv.comparator import CSVComparator
from py.files import api
from py.files.models import DataFile


CONTENT_TYPE_HEADER = 'Content-Type'
CONTENT_TYPE_HTML = 'text/html'
CONTENT_TYPE_JSON = 'text/json'


class UploadFiles(blobstore_handlers.BlobstoreUploadHandler):

    def post(self):
        uploads = self.get_uploads()

        # create data file entities for each uploaded file
        data_file_entities = []
        for upload in uploads:
            data_file = DataFile(blob_key=str(upload.key()), filename=upload.filename)
            data_file_entities.append(data_file)

        # store data file entities
        data_file_keys = ndb.put_multi(data_file_entities)

        # get the numerical ids to pass back to client
        data_file_ids = [key.id() for key in data_file_keys]

        # build a response
        response = {
            'result': 'success',
            'next_blob_upload_url': blobstore.create_upload_url('/files/upload'),
            'data': {
                'data_file_ids': data_file_ids
            }
        }

        self.response.headers[CONTENT_TYPE_HEADER] = CONTENT_TYPE_JSON
        self.response.write(json.dumps(response))


class DataFiles(webapp2.RequestHandler):

    def get(self):
        # retrieve data file entities
        data_file_ids = [int(data_file_id) for data_file_id in self.request.get_all('id')]
        data_file_entities = api.get_data_file_entities(data_file_ids)

        # build response
        response = {
            'result': 'success',
            'data': {
                'dataFiles': [dict(dfe.to_dict(), **dict(id=dfe.key.id())) for dfe in data_file_entities]
            }
        }

        self.response.headers[CONTENT_TYPE_HEADER] = CONTENT_TYPE_JSON
        self.response.write(json.dumps(response))


class CompareCSV(webapp2.RequestHandler):
    template = 'compare.html'

    def get(self):
        # retrieve data file entities
        data_file_ids = [int(data_file_id) for data_file_id in self.request.get_all('id')]
        data_file_entities = api.get_data_file_entities(data_file_ids)

        # map data files to blobs
        blob_map = {}
        for dfe in data_file_entities:
            blob_info = blobstore.BlobInfo.get(dfe.blob_key)
            blob_map[dfe.key.id()] = {
                'info': blob_info,
                'reader': csv.reader(BlobIterator(blob_info.open())),
            }

        # create a map of readers to pass to the comparator
        readers = {key: blob['reader'] for key, blob in blob_map.iteritems()}

        # use a CSV comparator to compare the csv files
        comparison = CSVComparator(readers).run()
        results = comparison.get_results()

        # build a response
        response = {
            'result': 'success',
            'data': {
                'comparison': results
            }
        }

        self.response.headers[CONTENT_TYPE_HEADER] = CONTENT_TYPE_JSON
        self.response.write(json.dumps(response))
