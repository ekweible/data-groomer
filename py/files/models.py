from google.appengine.ext import ndb


class DataFile(ndb.Model):
    blob_key = ndb.StringProperty()
    filename = ndb.StringProperty()
    type = ndb.StringProperty()


class DataDiscrepancy(ndb.Model):
    type = ndb.StringProperty()
    data_file_keys = ndb.StringProperty(repeated=True)
    results = ndb.JsonProperty()