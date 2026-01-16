
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
import urllib.request
from bs4 import BeautifulSoup
import re


class nwp_src():

    def __init__(self):
        self.parent_path = "https://dd.weather.gc.ca/"
        self.run_date_regex = r'^\d{8}/$'
        self.run_hour_regex = r'^\d{2}/$'
        self.run_step_regex = r'^\d{3}/$'
        self.data_regex = r'\.grib2$'
        self.model_path = "WXO-DD/model_gem_global/15km/grib2/lat_lon/"
        # process a subset of the available data
        self.required = [
            "TMP_TGL_2",  # screen temperature
            "DPT_TGL_2",  # screen dewpoint temperature
            "UGRD_TGL_10",  # 10m U wind
            "VGRD_TGL_10",  # 10m V wind
            "GUST_MAX_TGL_10",  # 10m wind gust
            "CAPE_SFC",  # cape
            "HGT_ISBL",  # Geopotential Height pressure levels
            "TMP_ISBL",  # Temperature pressure levels
            "UGRD_ISBL",  # U wind pressure levels
            "RH_ISBL",  # Relative Humidity
            "TMP_TGL",  # temperature height levels
            "UGRD_TGL",  # U wind height levels
            "VGRD_ISBL",  # V wind pressure levels
            "VGRD_TGL",  # U wind height levels
            "UGRD_TGL",  # U wind height levels
            "PRMSL_MSL"]  # MSL pressure

    def _get_data_uris(self, parent_path, chk_regex):
        """
        Parse the  open data web page and generate list of files from the latest run

        """
        html_src = parent_path
        try:
            html_text = urllib.request.urlopen(html_src).read()
            # Prepare the soup
            soup = BeautifulSoup(html_text, "html.parser")
            links = soup.find_all("a")
            rundates = []
            for link in links:
                match = re.match(chk_regex, link["href"])
                if match:
                    rundates.append(link["href"])

            return rundates
        except Exception as herr:
            print(herr)
            return []

    def get_files(self):
        """
        Get the files from the latest model run
        """
        day_uris = self._get_data_uris(self.parent_path, self.run_date_regex)
        day_uris.sort(reverse=True)
        latest_day_uri = f'{self.parent_path}{day_uris[0]}'
        run_uris = self._get_data_uris(
            f'{latest_day_uri}{self.model_path}', self.run_hour_regex)
        run_uris.sort(reverse=True)
        latest_run_uri = f'{latest_day_uri}{self.model_path}{run_uris[0]}'
        step_uris = self._get_data_uris(
            f'{latest_run_uri}', self.run_step_regex)
        step_uris.sort()
        model_run_str = f'{day_uris[0][:-1]}{run_uris[0][:-1]}'
        try:
            files_to_scan = {}
            for suri in step_uris:
                html_text = urllib.request.urlopen(
                    f'{latest_run_uri}{suri}').read()
                soup = BeautifulSoup(html_text, "html.parser")
                links = soup.find_all("a")

                for link in links:
                    if re.search(self.data_regex, link["href"]):
                        for pname in self.required:
                            if link["href"].find(pname) > -1:
                                if pname not in files_to_scan:
                                    files_to_scan[pname] = []
                                files_to_scan[pname].append(
                                    f'{latest_run_uri}{suri}{link["href"]}')
        except Exception as err:
            print(err)
        remote_protocol = 'https'
        return model_run_str, files_to_scan, remote_protocol
