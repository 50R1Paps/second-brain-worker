-- Git blob SHA of the master content a wiki page was ingested from; NULL when unknown.
ALTER TABLE files ADD COLUMN git_blob_sha TEXT;
