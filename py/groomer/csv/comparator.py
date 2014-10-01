class CSVRow(object):

    def __init__(self, source, cols, num):
        self.source = source
        self.cols = cols
        self.num = num
        self.key = tuple(cols)

    def __repr__(self):
        return '%s  [%s]  %s' % (self.source, self.num, self.cols)


class GroupCSVIterator(object):

    def __init__(self, iterators):
        self.iterators = iterators
        self.num_iterators = len(iterators)
        self.row_num = 0

    def __iter__(self):
        return self

    def next(self):
        exhausted_count = 0
        nexts = []
        for source, iterator in self.iterators.iteritems():
            try:
                nexts.append(CSVRow(source, iterator.next(), self.row_num))
            except StopIteration:
                exhausted_count += 1
                if exhausted_count >= self.num_iterators:
                    raise StopIteration

        self.row_num += 1

        # return list of all retrieved next values
        return nexts


class CSVComparator(object):

    def __init__(self, csv_readers_map):
        self.sources = csv_readers_map.keys()
        self.num_sources = len(self.sources)
        self.iterator = GroupCSVIterator(csv_readers_map)
        self.outstanding = {}
        self.results = {}

    def run(self):
        for rows in self.iterator:
            for row in rows:
                self.process_row(row)

        return self

    def process_row(self, row):
        # initialize list for this key if necessary
        if row.key not in self.outstanding:
            self.outstanding[row.key] = []

        # store the row
        self.outstanding[row.key].append(row)

        # prune the row if complete
        self.prune_row(row)

    def prune_row(self, row):
        if len(self.outstanding[row.key]) >= self.iterator.num_iterators:
            del self.outstanding[row.key]

    def get_results(self):
        if self.results:
            return self.results

        self.results = {source: {} for source in self.sources}

        for issue_rows in self.outstanding.itervalues():
            for row in issue_rows:
                self.results[row.source][row.num] = row.cols

        return self.results