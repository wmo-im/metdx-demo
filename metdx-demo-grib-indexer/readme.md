
# Kerchunk indexing example for metdx-demo

This component is meant to demonstrate how remote GRIB data could be indexed. It is a prototype.

## Usage

```
docker build -t the-image-name .
docker run -d --rm -v /path/to/host/data/folder:/app/model_gem_global_15KM the-image-name
```

## Development

This is based on Kerchunis a library that provides a unified way to represent a variety of chunked, compressed data formats, allowing efficient access to the data from traditional file systems or cloud object storage.

## TODO

* handling of unknown grib names
* automatically create and output pygeoapi config details
* convert to a plugin architecture to simplify adding new data sources
* Convert into an OGC API processes application
