from google.appengine.ext import ndb


def get_data_file_entities(data_file_ids):
    if not data_file_ids:
        return []

    # build data file keys and retrieve
    keys = [ndb.Key('DataFile', data_file_id) for data_file_id in data_file_ids]
    return ndb.get_multi(keys)