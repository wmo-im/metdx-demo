###############################################################################
#
# Licensed to the Apache Software Foundation (ASF) under one 
# or more contributor license agreements.  See the NOTICE file
# distributed with this work for additional information
# regarding copyright ownership.  The ASF licenses this file
# to you under the Apache License, Version 2.0 (the
# "License"); you may not use this file except in compliance
# with the License.  You may obtain a copy of the License at
#
#   http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing,
# software distributed under the License is distributed on an
# "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY 
# KIND, either express or implied.  See the License for the 
# specific language governing permissions and limitations
# under the License.
#
###############################################################################
import os
import json
from model_gem_global import nwp_src
from kerchunk.grib2 import scan_grib
from kerchunk.combine import MultiZarrToZarr


def save_file_info(uri, model_run_str):
    """Extract data location and metadata"""

    plist = scan_grib(uri)

    for p in plist:
        keys = list(p['refs'])
        param = keys[0].split("/")[0]
        if param == 'unknown':
            param = uri.split('/')[-1].split('_')[2].lower()
        p_dir = f'file_indexes/{model_run_str}/{param}'
        if not os.path.exists(p_dir):
            os.makedirs(p_dir, exist_ok=True)
        kerchunk_file = f'{p_dir}/{uri.split('/')[-1].replace('.grib2', '.json')}'
        with open(kerchunk_file, 'w', encoding='utf-8') as mout_f:
            mout_f.write(json.dumps(p))

        identical_dims = ['latitude', 'longitude']
        for key, value in p['refs'].items():
            if 'positive' in value:
                identical_dims.append(key.split("/")[0])

    return kerchunk_file, identical_dims


def scan_files():
    """
        Download files from server
    """
    model_name = "model_gem_global_15KM"
    nwp_src_data = nwp_src()
    model_run_str, files_to_scan, remote_protocol = nwp_src_data.get_files()

    try:
        for pkey, pVal in files_to_scan.items():
            kfiles = []
            iden_dims = ['latitude', 'longitude']
            for f in pVal:
                fname, iden_dims = save_file_info(f, model_run_str)
                kfiles.append(fname)

            mzz = MultiZarrToZarr(kfiles,
                                  remote_protocol=remote_protocol,
                                  concat_dims=['valid_time'],
                                  identical_dims=iden_dims)
            d = mzz.translate()

            if not os.path.exists(f"{model_name}/{model_run_str}"):
                os.makedirs(f"{model_name}/{model_run_str}", exist_ok=True)

            with open(f"{model_name}/{model_run_str}/{pkey}.json", 'w', encoding='utf-8') as out_f:
                out_f.write(json.dumps(d))

    except:
        print("error")


scan_files()
