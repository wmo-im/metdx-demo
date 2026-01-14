
# Web UI for metdx-demo

This component is meant to demonstrate how end-user tooling could look. It is a prototype.

## Usage

```
pip install .
flet run ./main.py
```

## Development

This UI is based on Flet. Flet is a python-based UI framework which compiles to web-assembly. It can be deployed locally or as a static webpage. Flet was chosen for its ease of development, useful for prototyping and demo'ing.

## TODO

* github action/pages build
* inspect collection link in the record view, differentiate EDR/Maps/STAC collections
* create view page for EDR with different data queries
* containerise the UI