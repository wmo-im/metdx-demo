# INFCOM-4 SG-FIT/LD demo  

## Contents

- [Step 1: Find the dataset](#step-1-find-the-dataset)
- [Step 2: The data is a pile of GRIB files](#step-2-the-data-is-a-pile-of-grib-files)
- [Step 3: Which file do I actually need?](#step-3-which-file-do-i-actually-need)
- [Step 4: Real-time: publish / subscribe](#step-4-real-time-publish--subscribe)
- [Step 5: Standardise the index: STAC](#step-5-standardise-the-index-stac)
- [Step 6: One message per file is a lot of messages](#step-6-one-message-per-file-is-a-lot-of-messages)
- [Step 7: Work at the dataset level: virtual Zarr](#step-7-work-at-the-dataset-level-virtual-zarr)
- [Step 8: For the rest of us, a Web API](#step-8-for-the-rest-of-us-a-web-api)
- [And Beyond: integration with AI agents](#and-beyond-integration-with-ai-agents)
  
## Step 1: Find the dataset  
![slide-1-step-1.png](images/slide-1-step-1.png)  
1. Setup:   
   - [labs.wis2dev.io](https://labs.wis2dev.io) Global Discovery Catalogue [https://wmo-resource-catalogue.labs.wis2dev.io/collections/wis2-discovery-metadata/](https://wmo-resource-catalogue.labs.wis2dev.io/collections/wis2-discovery-metadata/)  
   - Use “metdx-demo” keyword to make our demo metadata records easy to find  
2. Clarify terminology for “dataset”: in WIS2 context it’s a whole basket of resources - not an individual data file  
3. Search [labs.wis2dev.io](https://labs.wis2dev.io) for a dataset - keyword “metdx-demo”: ++urn:wmo:md:int-ecmwf:ecmwf-opendata-ifs-0p1-oper++ [note: watch for auto-correct shenanigans if you type “metdx-demo”]  
4. _(optional)_ Load the WCMP2 record into the WCMP2 editor at https://6a6d74.github.io/wcmp2-editor/ to show the record in a more human readable form - upload the record from URL https://wmo-resource-catalogue.labs.wis2dev.io/collections/wis2-discovery-metadata/items/urn:wmo:md:int-ecmwf:ecmwf-opendata-ifs-0p1-oper?f=json  
5. Talk about the “metadata driven workflow” (refer back to “Four mechanisms, one workflow” in the slides)   
6. Show the links in the HTML page  
7. Show the links in JSON; very brief overview of a links object, highlight `"rel": "collection"` as being the machine-readable instruction that says “this is a link to an interactive data resource” (e.g., an OGC or STAC API)  
8. We’ll come back to these links in the rest of the demo …  
  
## Step 2: The data is a pile of GRIB files  
![slide-2-step-2.png](images/slide-2-step-2.png)  
1. Example dataset: ++urn:wmo:md:int-ecmwf:ecmwf-opendata-ifs-0p1-oper++ … text/html link to “ECMWF Open Data portal (the GRIB2 files)” [https://data.ecmwf.int/forecasts/](https://data.ecmwf.int/forecasts/)   
2. Show the links in the WCMP2 record: [Web Accessible Folder](https://data.ecmwf.int/forecasts/)   
3. Web Accessible Folder (WAF) user interface; navigate the directory path  
4. One folder per day, plus “wis2” folder that only includes the WIS2 discovery metadata - not the data itself; all fine, but the user isn’t given any extra context about what is in each folder - they have to guess (albeit it’s fairly obvious for an *informed* human)  
   - Show & follow link to documentation pages … text/html link to “ECMWF open data documentation” [https://www.ecmwf.int/en/forecasts/datasets/open-data](https://www.ecmwf.int/en/forecasts/datasets/open-data)  
5. opendata/20261104/06z/ifs/0p1/oper/ folder includes “grib2” files   
   - “06z” is the run, “ifs” is the model, “0p1” is the resolution (0.1degree), “oper” is the stream (the ECMWF system that creates the data)  
6. file: [20261104060000-0h-oper-fc-pl.grib2](https://data.ecmwf.int/ecpds/home/opendata/20261104/06z/ifs/0p1/oper/20261104060000-0h-oper-fc-pl.grib2)   
7. Download the file to inspect - it’s 380MB  
8. Inspect the downloaded file using grib-utils/grib_inspect.py (ECMWF Earthkit under the covers: earthkit-data 1.3.1)  
  
```
python grib_inspect.py file.grib2
```
  
```
File:     ~/Downloads/20261104060000-0h-oper-fc-pl.grib2
Messages: 140

Date      Time  Step  StepType  LevelType
20261104   600     0  instant   isobaricInhPa

Grid / encoding (from first message):
  centre                               ecmf
  edition                              2
  marsClass                            od
  marsStream                           oper
  marsType                             fc
  gridType                             regular_ll
  Ni                                   3600
  Nj                                   1801
  iDirectionIncrementInDegrees         0.1
  latitudeOfFirstGridPointInDegrees    90.0
  latitudeOfLastGridPointInDegrees     -90.0
  longitudeOfFirstGridPointInDegrees   180.0
  longitudeOfLastGridPointInDegrees    179.9
  packingType                          grid_ccsds
  bitsPerValue                         16

Parameters (10):
  short   paramId  units        name                         levels
  z           129  m**2 s**-2   Geopotential                 10, 50, 100, 150, 200, 250, 300, 400, 500, 600, 700, 850, 925, 1000
  gh          156  gpm          Geopotential height          10, 50, 100, 150, 200, 250, 300, 400, 500, 600, 700, 850, 925, 1000
  t           130  K            Temperature                  10, 50, 100, 150, 200, 250, 300, 400, 500, 600, 700, 850, 925, 1000
  q           133  kg kg**-1    Specific humidity            10, 50, 100, 150, 200, 250, 300, 400, 500, 600, 700, 850, 925, 1000
  w           135  Pa s**-1     Vertical velocity            10, 50, 100, 150, 200, 250, 300, 400, 500, 600, 700, 850, 925, 1000
  vo          138  s**-1        Vorticity (relative)         10, 50, 100, 150, 200, 250, 300, 400, 500, 600, 700, 850, 925, 1000
  d           155  s**-1        Divergence                   10, 50, 100, 150, 200, 250, 300, 400, 500, 600, 700, 850, 925, 1000
  r           157  %            Relative humidity            10, 50, 100, 150, 200, 250, 300, 400, 500, 600, 700, 850, 925, 1000
  v           132  m s**-1      V component of wind          10, 50, 100, 150, 200, 250, 300, 400, 500, 600, 700, 850, 925, 1000
  u           131  m s**-1      U component of wind          10, 50, 100, 150, 200, 250, 300, 400, 500, 600, 700, 850, 925, 1000
```
  
9. Plot the downloaded file using grib-utils/grib_plot.py (ECMWF Earthkit under the covers: earthkit-data 1.3.1, earthkit-plots 1.0.4)  
  
```
python grib_plot.py file.grib2 plot.png --param t --level 1000
```
  
![t.png](images/07B26049-44BF-4ADD-ACE7-1FDC58C6421A.png)  
  
## Step 3: Which file do I actually need?  
![slide-3-step-3.png](images/slide-3-step-3.png)  
1. Example dataset: ++urn:wmo:md:int-ecmwf:ecmwf-opendata-ifs-0p1-oper++   
2. opendata/20261104/06z/ifs/0p1/oper/ includes “index” files that describe what is in each GRIB2 file - so you don’t have to download 380MB per file to figure that out  
3. JSON format - but non-standard (JSON Lines: one JSON object per GRIB message, giving its byte offset and length in the GRIB2 file)  
4. file: [20261104060000-0h-oper-fc-pl.index](https://data.ecmwf.int/ecpds/home/opendata/20261104/06z/ifs/0p1/oper/20261104060000-0h-oper-fc-pl.index)   
5. Download the file to read the index; approx 30KB, describing the 380MB GRIB2 file (~0.01% size)  
6. This index describes exactly that one GRIB2 file: .index files matched to .grib2 files by basename, there's no filename, URL or checksum  
7. Read the downloaded index file grib-utils/grib_index.py (simple python, no Earthkit)   
  
```
python grib_index.py file.index.json
```
  
```
Index:    ~/Downloads/20261104060000-0h-oper-fc-pl.index.json
Messages: 140

Date      Time  Step  LevelType  Messages
20261104  0600     0  pl         140

File-wide MARS keys:
  class                                od
  stream                               oper
  type                                 fc
  expver                               0001
  domain                               g

Byte layout:
  first offset                         0
  sum of message lengths               380,168,143 bytes
  expected GRIB file size              380,168,143 bytes
  gaps / overlaps                      0 / 0
  message size min / max               154,723 / 5,718,171 bytes

Parameters (10):
  param           bytes  levels
  z          63,426,585  10, 50, 100, 150, 200, 250, 300, 400, 500, 600, 700, 850, 925, 1000
  gh         25,520,103  10, 50, 100, 150, 200, 250, 300, 400, 500, 600, 700, 850, 925, 1000
  t          16,133,026  10, 50, 100, 150, 200, 250, 300, 400, 500, 600, 700, 850, 925, 1000
  q          22,006,909  10, 50, 100, 150, 200, 250, 300, 400, 500, 600, 700, 850, 925, 1000
  w          47,487,031  10, 50, 100, 150, 200, 250, 300, 400, 500, 600, 700, 850, 925, 1000
  vo         50,645,164  10, 50, 100, 150, 200, 250, 300, 400, 500, 600, 700, 850, 925, 1000
  d          58,898,976  10, 50, 100, 150, 200, 250, 300, 400, 500, 600, 700, 850, 925, 1000
  r          18,710,357  10, 50, 100, 150, 200, 250, 300, 400, 500, 600, 700, 850, 925, 1000
  v          40,729,215  10, 50, 100, 150, 200, 250, 300, 400, 500, 600, 700, 850, 925, 1000
  u          36,610,777  10, 50, 100, 150, 200, 250, 300, 400, 500, 600, 700, 850, 925, 1000
```
  
## Step 4: Real-time: publish / subscribe  
![slide-4-step-4.png](images/slide-4-step-4.png)  
1. Example dataset: ++urn:wmo:md:int-ecmwf:ecmwf-opendata-ifs-0p1-oper++   
2. Find the record in [wmo-resource-catalogue.labs.wis2dev.io](https://wmo-resource-catalogue.labs.wis2dev.io)   
3. Click on the “Subscribe to data notifications” button - the subscription configuration is provided  
   * Broker: [mqtts://everyone:everyone@gb.wis2dev.io:8883](mqtts://everyone:everyone@gb.wis2dev.io:8883)  
   * Topic: cache/a/wis2/int-ecmwf/data/core/weather/prediction/forecast/medium-range/deterministic/global  
   - *Aside: for the demo, the Global Broker is identified as [gb.wis2dev.io](https://gb.wis2dev.io) which is not connected to the operational feed, so the rest of the demo will use the Météo France Global Broker [mqtts://everyone:everyone@globalbroker.meteo.fr:8883](mqtts://everyone:everyone@globalbroker.meteo.fr:8883)* [note: this channel also includes messages for 0.25-degree IFS, AIFS and the wave model]  
4. Demonstrate a live feed of WIS2 Notification Messages:  
   - Open MQTTX-Web: In a browser, go to [https://mqttx.app/web-client](https://mqttx.app/web-client)   
   - Click + New Connection  
   - Complete the connection form:  
  
```
┌──────────────┬─────────────────────────────────────────────────┐
│    Field     │                      Value                      │
├──────────────┼─────────────────────────────────────────────────┤
│ Name         │ Meteo-France-Global-Broker                      │
├──────────────┼─────────────────────────────────────────────────┤
│ Client ID    │ leave the generated one (it must be unique)     │
├──────────────┼─────────────────────────────────────────────────┤
│ Host         │ choose wss://, then enter globalbroker.meteo.fr │
├──────────────┼─────────────────────────────────────────────────┤
│ Port         │ 443                                             │
├──────────────┼─────────────────────────────────────────────────┤
│ Path         │ /mqtt                                           │
├──────────────┼─────────────────────────────────────────────────┤
│ Username     │ everyone                                        │
├──────────────┼─────────────────────────────────────────────────┤
│ Password     │ everyone                                        │
├──────────────┼─────────────────────────────────────────────────┤
│ TLS          │ toggle to "yes"                                 │
├──────────────┼─────────────────────────────────────────────────┤
│ MQTT Version │ 5.0 (3.1.1 also works)                          │
└──────────────┴─────────────────────────────────────────────────┘
```
  
5. Click connect; the status should turn green  
6. Subscribe to a topic  
   - ECMWF’s forecast data will be published on topic “cache/a/wis2/int-ecmwf/data/core/weather/prediction/forecast/medium-range/deterministic/global” - but this data is only published at certain times following the completion of a model run  
   - So - to illustrate, we subscribe to the WIS2 Notifications Published by NOAA-NWS on topic “cache/a/wis2/us-noaa-nws/#“; add this topic with QoS 0; click Confirm  
7. Watch messages arrive - they appear in the right-hand pane  
8. At the top of the right-hand pane, set the payload format to JSON so each message is pretty-printed  
9. NOAA-NWS is a busy topic, so disconnect from the Global Broker to stop the messages arriving  
10. Inspect a notification message [note that this data is cached by the Global Caches so (a) you see several messages for each data object (one from each Global Cache), and (b) the URLs point to one of the Global Caches]  
  
```
Example WIS2 Notification Message
```
  
```
{
  "id": "3f886376-3be1-48bc-8a50-b2286c7e7a41",
  "type": "Feature",
  "conformsTo": ["http://wis.wmo.int/spec/wnm/1/conf/core"],
  "geometry": { "type": "Point", "coordinates": [-77.76444, 33.43583] },
  "properties": {
    "pubtime": "2026-11-05T18:45:52Z",
    "datetime": "2026-11-05T18:20:00Z",
    "metadata_id": "urn:wmo:md:us-noaa-nws:surface-ocean-observations:moored-buoy",
    "integrity": { "method": "sha512", "value": "TfjkUVFG…" },
    "global-cache": "kr-kma-global-cache"
  },
  "links": [
    {
      "rel": "canonical",
      "type": "application/bufr",
      "href": "https://wis2data.kma.go.kr/data/2026-11-05/cache/a/wis2/us-noaa-nws/…/BUOY_0-20002-0-4100013_….bufr4",
      "length": 152
    },
    { "rel": "alternate", "title": "Incoming Report", "href": "https://wis2node.globaldata.nws.noaa.gov/…" }
  ]
}
```
  
- Find the links array and the “canonical” link therein - this link object points to where you download the data from [note: mention link-relation `"rel": "canonical"` (or `"rel": "update"` for an update), media type of the target resource `type`, the URL `href`, and (optionally) the size of the resource `length`]   
- For a notification about ECMWF forecast data, the URL will (likely) point to the open data server, with `"type": "application/grib;edition=2"` (GRIB2) [note: ECMWF publishes a large volume of forecast data, so they set `"cache": false` which means that Global Caches don’t cache the data and the notification messages published on the cache/# topic use URLs that point to the original location of the data on ECMWF’s servers]  
11. Go back to the catalogue record; click “subscribe to data notifications” again; now click “add to wis2downloader” - the configuration is provided  
    * wis2downloader add-subscription --topic "cache/a/wis2/int-ecmwf/data/core/weather/prediction/forecast/medium-range/deterministic/global" [note: wis2downloader assumed to be subscribing to operational WIS2 Global Brokers]  
12. The demo environment already has a deployment of wis2downloader running, configured to subscribe to this topic  
    - In a browser, go to [http://localhost:8088](http://localhost:8088) - this shows a custom dashboard for the wis2downloader instance  
    - You can see: files on disk, volume of data download, the newest file, the age at which files are purged (GRIB files build up volume fast!), active subscriptions, global broker configuration [note: the purge here is aggressive; in 24 hours this one topic delivers about 165 GB of unique GRIB2 data in about 1,600 files, counting each file once]  
    - You also have the option to “[Browse the downloaded files](http://localhost:8088/files/)”; click this to see the files [note: this topic also carries 0.25-degree IFS, AIFS and wave GRIBs, but this deployment filters on the path and downloads only `/ifs/0p1/oper/` files - mention that WIS2 provides mechanisms to help clients filter based on metadata in the notification message for only the files they want - avoiding downloading unnecessary files; see cookbook [3.3.2 Client Side Filtering](https://wmo-im.github.io/wis2-cookbook/cookbook/wis2-cookbook-DRAFT.html#_client_side_filtering) and [3.12. Advertising client side filters for data subscriptions in WCMP2 and WNM](https://wmo-im.github.io/wis2-cookbook/cookbook/wis2-cookbook-DRAFT.html#_advertising_client_side_filters_for_data_subscriptions_in_wcmp2_and_wnm)]  
    - Select a file and use grib_inspect.py to examine the contents of the file, and grib_plot.py to display some data  

![Pasted Graphic.png](images/939B1840-251D-416D-9473-D2F94FCDC8BC.png)  
![wis2downloader-demo-architecture.png](images/7951CF68-71DC-423B-839F-9AE6130B280F.png)  
    
## Step 5: Standardise the index: STAC   
![slide-5-step-5.png](images/slide-5-step-5.png)  
1. This is where the recommendations from SG-FIT start - Steps 1–4 are already used in WIS2  
2. Show the links in the WCMP2 record: HTML [browser](https://6a6d74.github.io/ecmwf-stac/browser/), JSON [catalog](https://6a6d74.github.io/ecmwf-stac/stac/collection.json) [note: we use the `profile` attribute in the link block to distinguish the STAC collection resource from other collection resources; for a STAC static catalog the spec is: [https://schemas.stacspec.org/v1.0.0/collection-spec/json-schema/collection.json](https://schemas.stacspec.org/v1.0.0/collection-spec/json-schema/collection.json)]  
3. Browse the STAC catalog: HTML [browser](https://6a6d74.github.io/ecmwf-stac/browser/), JSON [catalog](https://6a6d74.github.io/ecmwf-stac/stac/collection.json)  
4. Find the same GRIB and Index resources that were inspected/plotted in Steps 2 and 3  
5. STAC browser is open-source; it reads JSON files that were automatically generated from the ECMWF open data using a python script; deployed as a workflow on GitHub it publishes the JSON resources to GitHub-Pages so they are publicly reachable; the workflow is scheduled to run once per hour to check for new open-data; generating the entire STAC catalogue takes only 1-2 minutes, reading the Index files rather than having to download the GRIBs themselves   
   - *Aside: First time only the workflow downloads one GRIB message per parameter, fetched by HTTP byte range to read names, units and the grid. This is cached in .cache/grib-metadata.json.*   
6. TL;DR - the STAC catalog describes the set of GRIBs as a data-cube  
7. How do STAC items compare with .index files? The Items are a small fraction of the size of the ECMWF index files for the same run …  
   - Pressure levels (00z/12z run): one STAC Item of about 86 KB, against 85 index files totalling about 2.6 MB.  
   - Surface (00z/12z run): one STAC Item of about 105 KB, against about 0.9 MB of index files.  
   - Whole catalog: about 1.9 MB of STAC Items, against roughly 35 MB of index files.  
   - The two do different jobs. The index files give byte offsets so you can fetch a single field from a GRIB2 file. The STAC Items describe each run's time, grid, variables and files so you can find the data.  
  
![ecmwf-stac-architecture.png](images/D4483EE4-7C35-4A32-9A77-973B4BD2F205.png)  
![ecmwf-stac-architecture-workflow.png](images/979A5579-AF50-493A-9B80-8E81265B67CA.png)  
  
## Step 6: One message per file is a lot of messages   
![slide-6-step-6.png](images/slide-6-step-6.png)  
[nothing to show here - just a verbal comment]  
[note: contrary to my earlier thinking there is one .index file for each .grib (purpose - provide metadata for the grib2 file *and* byte-offsets for individual GRIB fields)]  
1. One WNM message per GRIB file is a lot of messages; [note: for the topic we’re looking at, about 11,000 messages a day, including the copies from each Global Cache]  
2. WIS2 easily scales to handle this traffic volume, but it’s a lot for some users to manage;   
3. A possible improvement is to point a WIS2 Notification Message at the STAC Item for a model run to notify users when it is available - one notification message for an entire model run;  
4. The notification message points to the STAC Item, the STAC Item points to the Assets: GRIB and Index files  
5. If  “early access” to data is needed while a model run is still in progress, could publish WNM for a STAC item pointing to an incomplete (but self-consistent) set of GRIBs, and republish the STAC item with `"rel": "update"` and new `pubtime` when more data is available  
  
## Step 7: Work at the dataset level: virtual Zarr  
![slide-7-step-7.png](images/slide-7-step-7.png)  
1. Example dataset: ++urn:wmo:md:int-ecmwf:ecmwf-opendata-ifs-0p1-oper++  
2. Show the link-block (`"type": "application/vnd+zarr"`) pointing to the Zarr store  
   - The Zarr store is an Icechunk manifest containing indexes onto GRIB files published by ECMWF onto Microsoft Planetary Computer (Azure);   
   - The indexes are built by a python script (on a local machine or as a GitHub workflow; indexing all ~80 runs takes under 10 minutes on a laptop, but about 30 minutes as a GitHub workflow, writing to R2 from a US runner) and written to an object bucket on Cloudflare R2 - you can see the URL in the link  
   - In a browser, load the URL [https://pub-c0b5dafd5b604c39aea40eca9165a981.r2.dev/ifs-0p1-oper-azure](https://pub-c0b5dafd5b604c39aea40eca9165a981.r2.dev/ifs-0p1-oper-azure) - because the browser is asking (using HTTP headers) for content it understands, R2 returns the HTML landing page (also written by the python script); the landing page provides an overview of the Zarr dataset and some instructions to open it  
3. Let’s verify that we can access the Zarr   
   - First, let's take a look at what's in the Zarr store using a simple utility (`show_refs.py`) which reads metadata from the Icechunk manifest for chunks in the multi-dimensional array (e.g., chunk address `65/16/0/0`)  

```
.venv/bin/python show_refs.py sfc 2t --lead 0 24 48 --verify
```

```
chunk      init_time       lead_h  url                                                                        offset    length   param  verified
65/0/0/0   2026-11-06 06z  0       az://ecmwf/20261106/06z/ifs/0p1/oper/20261106060000-0h-oper-fc-sfc.grib2   5458375   1363746  2t     ok      
65/8/0/0   2026-11-06 06z  24      az://ecmwf/20261106/06z/ifs/0p1/oper/20261106060000-24h-oper-fc-sfc.grib2  86991560  1375763  2t     ok      
65/16/0/0  2026-11-06 06z  48      az://ecmwf/20261106/06z/ifs/0p1/oper/20261106060000-48h-oper-fc-sfc.grib2  87688347  1381383  2t     ok      
```
- For a `sfc` (surface)  variable such as 2t, that order is `(init_time, lead_time, latitude, longitude)`:

```
┌──────────┬───────────┬─────────────────┬───────────────────────────┬───────────────────────────────────────────┐
│ Position │ Dimension │   Chunk size    │           Index           │             Coordinate value              │
├──────────┼───────────┼─────────────────┼───────────────────────────┼───────────────────────────────────────────┤
│ 65       │ init_time │ 1 run           │ 65th run, counting from 0 │ 2026-11-06 06z, the newest of the 66 runs │
├──────────┼───────────┼─────────────────┼───────────────────────────┼───────────────────────────────────────────┤
│ 16       │ lead_time │ 1 step          │ 16th step                 │ +48 h                                     │
├──────────┼───────────┼─────────────────┼───────────────────────────┼───────────────────────────────────────────┤
│ 0        │ latitude  │ all 1801 values │ the only chunk            │ 90.0° to −90.0°, every 0.1°               │
├──────────┼───────────┼─────────────────┼───────────────────────────┼───────────────────────────────────────────┤
│ 0        │ longitude │ all 3600 values │ the only chunk            │ −180.0° to 179.9°                         │
└──────────┴───────────┴─────────────────┴───────────────────────────┴───────────────────────────────────────────┘
```

- For `pl` (pressure level) variables, the array dimensions are: `(init_time, lead_time, level, latitude, longitude)`.
- A single "data cube" holds all the data for many model runs. This makes it very easy to work with large sets of data - users don't have to open many individual files (this is all handled by software libraries).
- Now, we'll run a simple python utility smoke_test.py [note: use the local virtual python environment (venv): .venv/bin/python smoke_test.py ]  
- This runs some end-to-end tests: open the Zarr and count the model runs, check a known value (London 2 m temperature, 5 Nov 12z +24 h = 10.54 °C), read a 48-hour series for London from the newest run, and plot a UK map for the next 09:00 UTC [note: plot is saved locally at ~/Development/ecmwf-virtual-cube/plots/smoke_2t_uk_<YYYYMMDDThhmm>.png ]   
4. Now, let’s do some interactive queries into the Zarr dataset using python notebooks … aim is to simulate how a scientific or data-analyst might use the data (e.g., for complex calculation, AI model training etc.) [note: local deployment of python notebooks in VS-Code]  
   - Exploring the ECMWF IFS 0.1° virtual cube: choose the location (Geneva), choose the time (22h local to the location), run the notebook: explore_cube.ipynb  
       - In the "Settings: where and when" block, set the place ("Geneva" - looked up using a gazetteer) and time ("22:00" - adjusted to local time at the place).
       - See the simple functions to open and read the data [note: ecmwf_cube.py imports xarray at the top of the module (import xarray as xr), along with WrapperStore from zarr.storage; open_cube uses xarray to open each group (see code block 1 “Open the cube”)]  
   - Something more complicated - Home Solar Forecast: choose location, how many/what type of solar panels, panel direction and tilt angle, etc.: solar_forecast.ipynb  
       - credit Dr Lara Gunn (Met Office), based on her notebook *Home Solar Forecast: the algorithm*  
       - Input your configuration in the "Settings" block - location (`PLACE`), solar panel information (number of `panels`, power output for each panel in `watts`, `azimuth` direction clockwise from north, and `tilt` angle).   
       - The notebook steps through retrieving the required information; "The forecast data, from the cube" is where the data is retrieved, starting with a one-line statement to open the cube: `sfc = open_cube("sfc", repo=PUBLIC_REPO)`. You can see which runs are used below block 2 (e.g., `run 2026-11-06 00z: 41 lead times, +0 .. +174 h`).
       - Next, the notebook calculates the sun position, clear-sky sunlight amounts, accumulations over time, solar panel outputs, daily totals. 
       - The notebook finishes by estimating how much power a battery would charge, recommends when to run heavy appliances, and generates some charts.

==TODO Adam will send more notebooks==  
  
![ecmwf-virtual-cube-architecture.png](images/47B626F6-A626-4526-9F6C-D6880BBB956C.png)  
![ecmwf-virtual-cube-architecture-workflow.png](images/C9876A37-EAFA-45A1-B155-77E19C365C2D.png)  
  
## Step 8: For the rest of us, a Web API  
![slide-8-step-8.png](images/slide-8-step-8.png)  
1. **Recap the record's links:** one WCMP2 record, and its links say how to get the data: files (Steps 2–3), notifications (Step 4), a STAC catalogue (Step 5), a Zarr store (Step 7) and, here, **OGC APIs**: EDR for subsets, Maps for images. *"The user doesn't need to know it's GRIB, netCDF, Zarr or anything else."*
2. Open the **metdx-demo Web UI**: https://wmo-im.github.io/metdx-demo/metdx-demo-ui/ ([source](https://github.com/wmo-im/metdx-demo/tree/main/metdx-demo-ui)). It searches the same Global Discovery Catalogue as Step 1, with **metdx-demo** already in the search box. Records matching the catalogue search are shown in the left-hand panel. You can see all the other catalogue records listed if you delete the text in the search box.
3. Each record in the list shows whether it offers interactive access through `EDR` or `OGC Maps`. The Web UI works this out from the metadata alone: it follows the record's `collection` links and reads the collection metadata at the other end.
4. Open the ECMWF 0.1° record "ECMWF physics-based deterministic forecast at 0.1°". The record page shows its OGC API collections. There's quite a lot of metadata shown for this record - so scroll down to see the "Data Access" section. You can see that the following EDR query types are supported: `position`, `radius`, `area`, `cube`, `trajectory` and `corridor`, plus `instances`: the individual model runs, so you can query a particular run rather than the latest. All of these are part of the standard OGC API – EDR specification, though an EDR endpoint doesn't have to support all of them.
5. The `collection` resource is JSON metadata. Click on the "OGC EDR" (`collection`) link to load it (target: https://polytope-edr.lumi.apps.dte.destination-earth.eu/collections/operational-data?f=json). It's a standard-compliant JSON document meant for machines not humans. It contains all the metadata needed for the Web UI to build a meaningful query interface for a user - everything is driven by the metadata. As an example, search in the JSON for `data_queries` - this shows the query types that the EDR end-point supports.
6. A short explainer for the data pipeline - from source to OGC API endpoint

   ![ECMWF Polytope EDR pipeline: from the Fields DataBase to OGC API – EDR](images/ecmwf-polytope-edr-pipeline.png)

7. **EDR:** open the EDR query builder:
   - You'll see the available parameters - let's pick `2t` (2m temperature)
   - The date/time range for data availability is also shown, with selectable options driven by metadata - keep "Start date" as default, and pick an "End date" two days into the future with "End time" at midday
   - _(for simplicity, we'll skip over the "Use a specific instance" option - this allows the user to query data from a specific model run instance; default is the most recent)_
8. Select query type "POSITION", then "Draw position" and pick a point on the map (e.g. Geneva)
   - The Web UI builds the EDR query and displays it at the bottom of the page 
   - Click "Open in browser" (↗) to open the query URL in a new tab - it's more JSON (CoverageJSON), again, designed for machines not humans
   - Back in the Web UI click "Fetch" to illustrate how machines can make data interpretable to humans - the Web UI zooms in on the point and displays a time-series chart in the left-hand panel; if you move the time-slider, the dot on the map changes colour according to the temperature scale.
9. Now - let's do an area query - select "AREA" query type:
   - Zoom out to the European area
   - Select "RECTANGLE", then "Draw area" - draw the bounding box on the map _(don't select too large an area - this test service is limited in the amount of data it will return in a single query)_
   - In the "Datetime" section, select "RANGE" - we want data for several steps
   - To reduce the amount of data we're asking for, narrow the "Datetime" window to 6 hours
   - Again, you see the EDR query URL that's been built
   - Click "Fetch" _(this can take a while depending on the time duration and bounding box size)_ - the Web UI zooms into the requested area and plots the data on the map ("CONTOURS" or "POINTS" for different plotting styles)
   - Use the time-slider to step through the hourly data steps
10. **Maps:** _(time allowing)_ open the Maps view: a rendered forecast map, no data handling at all.
11. Now head back to the main catalogue search page and select the "Canadian weather forecast \[experimental\]" dataset
    - A short explainer for the data pipeline:

    ![Canadian VOF pipeline: from NWP models to OGC API – EDR](images/canadian-vof-pipeline.png)

12. **Maps:**
    - **==TODO==** _Add section for Maps request - currently giving HTTP 500 responses_
13. **EDR:**
    - Zoom into the Great Lakes area
    - In the query builder only "POSITION" is available: this EDR endpoint supports only position queries (plus `instances`, its model runs). It's the same `data_queries` metadata you saw for ECMWF in point 5; open the "OGC EDR" `collection` link to compare.
    - Click "Draw position", then add a point on the map (e.g., Toronto), select "AirTemp (Air Temperature) \[celsius\]" from the parameter list, and click "Fetch" _(we leave the "Datetime" selector with default values to select the complete time-range)_
    - The Web UI zooms in on the selected point and shows the time-series chart in the left-hand panel _(use the time-slider to see the dot on the map change colour)_
14. What about a larger dataset? Head back to the catalogue search page and select the "ERA5 hourly reanalysis on single levels, served from cloud-optimised Zarr" dataset: a global dataset with data from 1940 to the present (about a week behind real time)
    - _Behind this: ERA5 is stored as analysis-ready, cloud-optimised (ARCO) Zarr, in two copies: one chunked for time series at a point, one for whole maps. A position query reads the time-series copy, so a decade at a single point comes back in seconds._
    - A short explainer for the data pipeline:

    ![ERA5 ARCO pipeline: from the Copernicus archive to OGC API – EDR](images/era5-arco-edr-pipeline.png)

15. **EDR:**
    - Open the EDR query builder. This time the query types are "POSITION", "AREA" and "CUBE": this endpoint's `data_queries` offers three of the six you saw for the ECMWF forecast. Same UI, different metadata.
    - For "POSITION" query, click "Draw position" then select a point on the map - e.g., Geneva
    - Select a "Parameter" - e.g., "t2m (2 metre temperature) \[K\]"
    - Select 10 years of data in the "Datetime" panel - e.g., 2016-01-01 00:00 to 2025-12-31 23:59
    - Click "Fetch". Ten years of hourly data (about 87,600 values) comes back in around ten seconds, and you can see the annual temperature cycle
16. **==TODO==** _Add sections for other datasets, e.g., "Met Office Global Model forecast via OGC EDR (ICE demo, Met Office Labs)" << ==this service is currently timing out==_
17. Using Web APIs isn't just a future thing - in Europe, [EUMETNET](https://www.eumetnet.eu) has built on the foundations of WIS2 with [MeteoGate](https://meteogate.eu) to provide federated access to Web services from its Members.
    - MeteoGate includes a Web application called [Data Explorer](https://explorer.meteogate.eu/workspace/defaultDataExplorerWorkspacePreset) _(based on [GeoWeb](https://opengeoweb.gitlab.io) - developed by KNMI, MetNo, and FMI)_ - open [Data Explorer](https://explorer.meteogate.eu/workspace/defaultDataExplorerWorkspacePreset) in a browser
    - Data Explorer loads presets for common tooling - starting with a widget to search the WIS2 Catalogue
    - Unselect the "MeteoGate only" button to see all the WIS2 catalogue records
    - Filter by country, e.g. "Austria" (a handful of records), click on the information icon "i" to inspect a WIS2 discovery metadata record
    - Most datasets in WIS2 aren't yet exposed through APIs - so let's jump to some that are: click "Data Explorer" on the top menu bar to load a new preset, select "Meteogate - Surface Observations" which will load map and data panels side-by-side
    - Behind the scenes Data Explorer is talking to an OGC API EDR endpoint for the E-SOH system (EUMETNET Supplementary Observations Datahub, see documentation [here](https://github.com/EUMETNET/e-soh-documentation/wiki/1.-Get-started)) that publishes a rolling 24-hour cache of observations for observing stations operated by EUMETNET Members
    - The map panel is showing "frog-spawn": one dot for each observing station from which data is available
    - On the map, pick a station (e.g., Helsinki Kumpula) and the data panel loads the last 24 hours of data for each parameter the station reports
18. The point: the UI knows nothing about ECMWF or ECCC. Everything it does comes from each record's links and the collection metadata behind them (**metadata-driven**). That's why the same UI offered six query types for the ECMWF forecast, three for ERA5 and only `position` for Canada. And MeteoGate's Data Explorer shows the same pattern at European scale: catalogue first, then standard APIs.

The UI is a static web page (GitHub Pages): the browser calls the catalogue and the APIs directly. Direct links for the ECMWF 0.1° record:
- [this record in the UI](https://wmo-im.github.io/metdx-demo/metdx-demo-ui/#/record/urn%3Awmo%3Amd%3Aint-ecmwf%3Aecmwf-opendata-ifs-0p1-oper)
- [EDR query builder](https://wmo-im.github.io/metdx-demo/metdx-demo-ui/#/record/urn%3Awmo%3Amd%3Aint-ecmwf%3Aecmwf-opendata-ifs-0p1-oper/edr?col=https%3A%2F%2Fpolytope-edr.lumi.apps.dte.destination-earth.eu%2Fcollections%2Foperational-data%3Ff%3Djson)
- [Maps view](https://wmo-im.github.io/metdx-demo/metdx-demo-ui/#/record/urn%3Awmo%3Amd%3Aint-ecmwf%3Aecmwf-opendata-ifs-0p1-oper/maps?col=https%3A%2F%2Fpolytope-edr.lumi.apps.dte.destination-earth.eu%2Fcollections%2Foperational_map_server%3Ff%3Djson)

## And Beyond: integration with AI agents   
![slide-9-beyond.png](images/slide-9-beyond.png)  
_(time permitting)_  
1. Example dataset: ++urn:wmo:md:int-ecmwf:ecmwf-opendata-ifs-0p1-oper++  
2. Show the links in the WCMP2 metadata record   
  
```json
{
  "rel": "service",
  "href": "https://mcp.ecmwf.int",
  "type": "application/json",
  "profile": "https://modelcontextprotocol.io/specification/2025-11-25",
  "title": "The official Model Context Protocol service of ECMWF, providing the institute's forecasts, climate data, charts and catalogue information through one endpoint"
}
```
  
3. Have Claude search the WCMP2 [record](https://wmo-resource-catalogue.labs.wis2dev.io/collections/wis2-discovery-metadata/items/urn:wmo:md:int-ecmwf:ecmwf-opendata-ifs-0p1-oper) (or the whole [catalogue](https://wmo-resource-catalogue.labs.wis2dev.io/collections/wis2-discovery-metadata)?) for an MCP server  
4. Claude chat can’t add a connector to itself. Connectors are account settings - so we need to add it [note: remember to disconnect from the MCP server before the demo]  
   - Open Settings → Customize → Connectors, on claude.ai or in the desktop app  
   - Click Add custom connector  
   - Enter a name, such as ECMWF, and the URL [https://mcp.ecmwf.int/](https://mcp.ecmwf.int/)  
   - Click Add → Connect - it shows the server's tools, such as charts_get_meteogram and charts_get_chart.  
   - In Claude chat, open the tools menu (the + or slider icon under the message box) and make sure ECMWF is switched on.   
5. Ask in Claude chat "Show me the ECMWF meteogram for Geneva."  
   - See the result  
   - Expand the steps to show the tool use  
  
==TODO … @awarde96==  
- Add the “open-data” skill to this MCP server - it doesn’t use EDR, but it’s still illustrative  
- Request the EDR endpoint to be re-enabled - even for a short period to record a video snippet of it working (*the EDR endpoint is disabled because it really needs access control before it’s shared publicly*)  
  
### Notes for the demo:  
- Aim: show tool usage by an Agent (e.g., Claude or MistralAI)  
- Claude in the chat can't add a connector to itself. Connectors are account settings, and it has no tool that changes your settings. The most it can do is explain the steps, or tell you which tools it currently has.  
- Leave the advanced OAuth settings empty; the ECMWF MCP server doesn't use them  
- This MCP server doesn’t have access to the IFS 0.1 degree operational forecast model data  
- Ideally include a skill that requests data via OGC-API EDR  

