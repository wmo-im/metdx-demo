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
import fsspec

class nwp_src():

    def __init__(self):
        self.s3 = fsspec.filesystem('s3', anon=True, skip_instance_cache=True)
        self.bucket_name = "noaa-gfs-bdp-pds"
        self.forecast_model = "atmos"
        self.file_type = "pgrb2"

    def _list_files(self, fpath):
        files = self.s3.ls(fpath)
        return files

    def get_files(self):
        all_files = self._list_files(self.bucket_name)
        all_files.sort(reverse=True)
        forecast_dates = []
        for file in all_files:
            if "gfs." in file:
                forecast_dates.append(file)
        forecast_cycles = self._list_files(forecast_dates[0])
        if len(forecast_cycles) == 1:
            forecast_cycles = self._list_files(forecast_dates[-2])

        prefix = f"{forecast_cycles[-2]}/{self.forecast_model}/"

        forecast_files = self._list_files(prefix)
        files_to_scan = []
        for file in forecast_files:
            if f".{self.file_type}." in file:
                print(file)

        remote_protocol = 's3'
        parts = forecast_cycles[-2].split("/")

        model_run_str = f'{parts[-2].split(".")[1]}{parts[-1]}'
        return model_run_str, files_to_scan, remote_protocol
