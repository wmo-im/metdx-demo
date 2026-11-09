# INFCOM-4 SG-FIT/LD demo  
  
## Step 1: Find the dataset  
![slide-1-step-1.png](images/slide-1-step-1.png)  
1. Setup:   
- [labs.wis2dev.io](https://labs.wis2dev.io) Global Discovery Catalogue [https://wmo-resource-catalogue.labs.wis2dev.io/collections/wis2-discovery-metadata/](https://wmo-resource-catalogue.labs.wis2dev.io/collections/wis2-discovery-metadata/)  
- Use “metdx-demo” keyword to make our demo metadata records easy to find  
2. Clarify terminology for “dataset”: in WIS2 context it’s a whole basket of resources - not an individual data file  
3. Search [labs.wis2dev.io](https://labs.wis2dev.io) for a dataset - keyword “metdx-demo”: ++urn:wmo:md:int-ecmwf:ecmwf-opendata-ifs-0p1-oper++ [note: watch for auto-correct shenanigans if you type “metdx-demo”]  
4. _(optional)_ Load the WCMP2 record into the WCMP2 editor at https://6a6d74.github.io/wcmp2-editor/ to show the record in a more human readable form - upload the record from URL https://wmo-resource-catalogue.labs.wis2dev.io/collections/wis2-discovery-metadata/items/urn:wmo:md:int-ecmwf:ecmwf-opendata-ifs-0p1-oper?  
5. Talk about the “metadata driven workflow” (refer back to “Four mechanisms, one workflow” in the slides)   
6. Show the links in the HTML page  
7. Show the links in JSON; very brief overview of a links object, highlight “rel”:”collection” as being the machine-readable instruction that says “this is a link to an interactive data resource” (e.g., an OGC or STAC API)  
8. We’ll come back to these links in the rest of the demo …  
  
## Step 2: The data is a pile of GRIB files  
![slide-2-step-2.png](images/slide-2-step-2.png)  
1. Example dataset: ++urn:wmo:md:int-ecmwf:ecmwf-opendata-ifs-0p1-oper++ … text/html link to “ECMWF Open Data portal (the GRIB2 files)” [https://data.ecmwf.int/forecasts/](https://data.ecmwf.int/forecasts/)   
2. Show the links in the WCMWP2 record: [Web Accessible Folder](https://data.ecmwf.int/forecasts/)   
3. Web Accessible Folder (WAF) user interface; navigate the directory path  
4. One folder per day,  plus “wis2” folder that only includes the WIS2 discovery metadata - not the data itself; all fine, but the user isn’t given any extra context about what is in each folder - they have to guess (albeit it’s fairly obvious for an *informed* human)  
- Show & follow link to documentation pages … text/html link to “ECMWF open data documentation” [https://www.ecmwf.int/en/forecasts/datasets/open-data](https://www.ecmwf.int/en/forecasts/datasets/open-data)  
5. opendata/20261104/06z/ifs/0p1/oper/ folder includes “grib2” files   
- “06z” is the run, “ifs” is the model, “0p1” is the resolution (0.1degree), “oper” is the stream (the ECMWF system that creates the data  
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
3. JSON format - but non-standard  
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
- *Aside: for the demo, the Global Broker is identified as [gb.wis2dev.io](https://gb.wis2dev.io) which is not connected to the operational feed, so the rest of the test will use the Météo France Global Broker [mqtts://everyone:everyone@globalbroker.meteo.fr:8883](mqtts://everyone:everyone@globalbroker.meteo.fr:8883)* [note: this channel also includes messages for 0.25-degree IFS and the Wave model]  
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
10. Inspect a notification message [note that this data is cached by the Global Caches so (a) you see six message for each data object, and (b) the URLs point to one of the Global Caches]  
  
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
  
- Find the links array and the “canonical” link therein - this link object points to where you download the data from [note: mention link-relation “rel”:”canonical” (or “update” for an update), media type of the target resource “type”, the URL “href”, and (optionally) the size of the resource “length”]   
- For a notification about ECMWF forecast data, the URL will (likely) point to the open data server, with “type”:”application/grib;edition=2" (GRIB2) [note: ECMWF publishes a large volume of forecast data, so they set “cache”:”false” which means that Global Caches don’t cache the data and the notification messages published on the cache/# topic use URLs that point to the original location of the data on ECMWF’s servers]  
11. Go back to the catalogue record; click “subscribe to data notifications” again; now click “add to wis2downloader” - the configuration is provided  
    * wis2downloader add-subscription --topic "cache/a/wis2/int-ecmwf/data/core/weather/prediction/forecast/medium-range/deterministic/global" [note: wis2downloader assumed to be subscribing to operational WIS2 Global Brokers]  
2. The demo environment already has a deployment of wis2downloader running, configured to subscribe to this topic  
- In a browser, go to [http://localhost:8088](http://localhost:8088) - this shows a custom dashboard for the wis2downloader instance  
- You can see: files on disk, volume of data download, the newest file, the age at which files are purged (GRIB files build up volume fast!), active subscriptions, global broker configuration [note: the purge here is aggressive; in 24 hours this one topic delivers about 120 GB of unique GRIB2 data in about 1,200 files, counting each file once]  
- You also have the option to “[Browse the downloaded files](http://localhost:8088/files/)”; click this to see the files [note: this topic also serves 0.25-degree GRIBs too - if you see some of these, mention that WIS2 provides mechanisms to help clients filter based on metadata in the notification message for only the files they want - avoiding downloading unnecessary files; see cookbook [3.3.2 Client Side Filtering](https://wmo-im.github.io/wis2-cookbook/cookbook/wis2-cookbook-DRAFT.html#_client_side_filtering) and [3.12. Advertising client side filters for data subscriptions in WCMP2 and WNM](https://wmo-im.github.io/wis2-cookbook/cookbook/wis2-cookbook-DRAFT.html#_advertising_client_side_filters_for_data_subscriptions_in_wcmp2_and_wnm)]  
- Select a file and use grib_inspect.py to examine the contents of the file, and grib_plot.py to display some data  

![Pasted Graphic.png](images/939B1840-251D-416D-9473-D2F94FCDC8BC.png)  
![wis2downloader-demo-architecture.png](images/7951CF68-71DC-423B-839F-9AE6130B280F.png)  
    
## Step 5: Standardise the index: STAC   
![slide-5-step-5.png](images/slide-5-step-5.png)  
1. This is where the recommendations from SG-FIT start - steps 1-4 are used WIS2 already  
2. Show the links in the WCMWP2 record: HTML [browser](https://6a6d74.github.io/ecmwf-stac/browser/), JSON [catalog](https://6a6d74.github.io/ecmwf-stac/stac/collection.json) [note: we use the “profile” attribute in the link block to distinguish the STAC collection resource from other collection resources; for a STAC static catalog the spec is: [https://schemas.stacspec.org/v1.0.0/collection-spec/json-schema/collection.json](https://schemas.stacspec.org/v1.0.0/collection-spec/json-schema/collection.json)]  
3. Browse the STAC catalog: HTML [browser](https://6a6d74.github.io/ecmwf-stac/browser/), JSON [catalog](https://6a6d74.github.io/ecmwf-stac/stac/collection.json)  
4. Find the same GRIB and Index resources that were inspected/plotted in Steps 2 and 3  
5. STAC browser is open-source; it reads JSON files that were automatically generated from the ECMWF open data using a python script; deployed as a workflow on GitHub it publishes the JSON resources to GitHub-Pages so they publicly reachable; the workflow is scheduled to run once per hour to check for new open-data; generating the entire STAC catalogue takes only 1-2 minutes, reading the Index files rather than having to download the GRIBs themselves   
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
1. One WNM message per GRIB file is a lot of messages; [note: estimate is that for the topic we’re looking at it’s about 8000 messages a day (including duplicates from each of 6 Global Caches)]  
2. WIS2 easily scales to handle this traffic volume, but it’s a lot for some users to manage;   
3. A possible improvement is to point a WIS2 Notification Message at the STAC Item for a model run to notify users when it is available - one notification message for an entire model run;  
4. The notification message points to the STAC Item, the STAC Item points to the Assets: GRIB and Index files  
5. If  “early access” to data is needed while a model run is still in progress, could publish WNM for a STAC item pointing to an incomplete (but self-consistent) set of GRIBs, and republish the STAC item with “rel”:”update” and new “pubtime” when more data is available  
  
## Step 7: Work at the dataset level: virtual Zarr  
![slide-7-step-7.png](images/slide-7-step-7.png)  
1. Example dataset: ++urn:wmo:md:int-ecmwf:ecmwf-opendata-ifs-0p1-oper++  
2. Show the link-block ("type": "application/vnd+zarr") pointing to the Zarr store  
- The Zarr store is an Icechunk manifest containing indexes onto GRIB files published by ECMWF onto Microsoft Planetary Computer (Azure);   
- The indexes are built by a python script (either on a local machine or a GitHub workflow, all 60+ runs took <10 minutes to index) and written to an object bucket on Cloudflare R2 - you can see the URL in the link  
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
- This runs some end-to-end tests: open the Zarr, count how many model runs, check a value (2m temp, London, 12z tomorrow), compare how that value changes over several model runs, make a plot [note: plot is saved locally at ~/Development/ecmwf-virtual-cube/plots/smoke_2t_uk_<YYYYMMDDThhmm>.png ]   
4. Now, let’s do some interactive queries into the Zarr dataset using python notebooks … aim is to simulate how a scientific or data-analyst might use the data (e.g., for complex calculation, AI model training etc.) [note: local deployment of python notebooks in VS-Code]  
- Exploring the ECMWF IFS 0.1° virtual cube: choose the location (Geneva), choose the time (22h local to the location), run the notebook: explore_cube.ipynb  
    - In the "Settings: where and when" block, set the place ("Geneva" - looked up using a gazeteer) and time ("22:00" - adjusted to local time at the place).
    - See the simple functions to open and read the data [note: ecmwf_cube.py imports xarray at the top of the module (import xarray as xr), along with WrapperStore from zarr.storage; open_cube uses xarray to open each group (see code block 1 “Open the cube”)]  
- Something more complicated - Home Solar Forecast: choose location, how many/what type of solar panels, panel direction and tilt angle, etc.: solar-forecast-algorithm.ipynb  
    - credit Dr. Lara Gunn (Met Office)  
    - Input your configuration in the "Settings" block - location (`PLACE`), solar panel information (number of `panels`, power output for each panel in `watts`, `azimuth` direction clockwise from north, and `tilt` angle).   
    - The notebook steps through retrieving the required information; "The forecast data, from the cube" is where the data is retrieved, starting with a one-line statement to open the cube: `sfc = open_cube("sfc", repo=PUBLIC_REPO)`. You can what data is using below block 2 (e.g., `run 2026-11-06 00z: 41 lead times, +0 .. +174 h`).
    - Next, the notebook calculates the sun position, clear-sky sunlight amounts, accumulations over time, solar panel outputs, daily totals. 
    - The notebook finishes by estimating how much power a battery would charge, recommends when to run heavy appliances, and generates some charts.

==TODO Adam will send more notebooks==  
  
![ecmwf-virtual-cube-architecture.png](images/47B626F6-A626-4526-9F6C-D6880BBB956C.png)  
![ecmwf-virtual-cube-architecture-workflow.png](images/C9876A37-EAFA-45A1-B155-77E19C365C2D.png)  
  
## Step 8: For the rest of us, a Web API  
![slide-8-step-8.png](images/slide-8-step-8.png)  
==TODO==  
* Show the links in the WCMP2 record; recap on the “metadata driven workflow” (ref. back to “Four mechanisms, one workflow” in the slides)  
* use metdx-demo UI client to interact with data through OGC APIs   
* Possible inclusion: GeoWeb end-points   
* @m-burgoyne suggests “User doesn’t need to know it’s GRIB, netCDF, Zarr or anything else”   
  
## And Beyond: integration with AI agents   
![slide-9-beyond.png](images/slide-9-beyond.png)  
[time permitting]  
1. Example dataset: ++urn:wmo:md:int-ecmwf:ecmwf-opendata-ifs-0p1-oper++  
2. Show the links in the WCMP2 metadata record   
  
```
{
  "rel": "service",
  "href": "https://mcp.ecmwf.int”,
  "type": "application/json",
  "profile": "https://modelcontextprotocol.io/specification/2025-11-25",
  "title": “The official Model Context Protocol service of ECMWF, providing the institute's forecasts, climate data, charts and catalogue information through one endpoint"
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
- Request the EDR endpoint to to be re-enabled - even for a short period to record a video snippet of it working (*the EDR endpoint is disabled because it really needs access control before it’s shared publicly*)  
  
### Notes for the demo:  
- Aim: show tool usage by an Agent (e.g., Claude or MistralAI)  
- Claude in the chat can't add a connector to itself. Connectors are account settings, and it has no tool that changes your settings. The most it can do is explain the steps, or tell you which tools it currently has.  
- Leave the advanced OAuth settings empty; the ECMWF MCP server doesn't use them  
- This MCP server doesn’t have access to the IFS 0.1 degree operational forecast model data  
- Ideally include a skill that requests data via OGC-API EDR  

