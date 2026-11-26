# =================================================================
#
# Authors: Tom Kralidis <tomkralidis@gmail.com>
#
# Copyright (c) 2026 Tom Kralidis
#
# Permission is hereby granted, free of charge, to any person
# obtaining a copy of this software and associated documentation
# files (the "Software"), to deal in the Software without
# restriction, including without limitation the rights to use,
# copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the
# Software is furnished to do so, subject to the following
# conditions:
#
# The above copyright notice and this permission notice shall be
# included in all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
# EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES
# OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
# NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
# HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
# WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
# FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
# OTHER DEALINGS IN THE SOFTWARE.
#
# =================================================================

import io
import logging
from pathlib import Path

import cartopy.crs as ccrs
import matplotlib
import matplotlib.pyplot as plt
from shapely import box
import xarray as xr

from pygeoapi.provider.base import BaseProvider, ProviderInvalidDataError
from pygeoapi.provider.xarray_edr import XarrayEDRProvider

matplotlib.use('Agg')

LOGGER = logging.getLogger(__name__)


class MSCVOFEDRProvider(XarrayEDRProvider):
    def __init__(self, provider_def):
        super().__init__(provider_def)

    def get_fields(self):
        print("GET_FIELDS")
        if not self._fields:
            for key, value in self._data.variables.items():
                if key not in self._data.coords:
                    LOGGER.debug('Adding variable')
                    dtype = value.dtype
                    if dtype.name.startswith('float'):
                        dtype = 'float'
                    elif dtype.name.startswith('int'):
                        dtype = 'integer'
                    elif dtype.name.startswith('str'):
                        dtype = 'string'

                    self._fields[key] = {
                        'type': dtype,
                        'title': value.attrs.get('long_name'),
                        'x-ogc-unit': value.attrs.get('units')
                    }

        if self.time_field in self._data.dims:
            self._fields['datetime'] = { 
                'type': 'string',
                'enum': list(self._data[self.time_field].astype(str).values),
                'x-ogc-unit': 'h'
            }  

        datadir = Path(self.data).parent

        instance_ids = sorted([d.stem[:12] for d in datadir.iterdir() if d.suffix == '.zarr'], reverse=True)

        self._fields['instance_id'] = {
            'type':'string',
            'enum': instance_ids,
            'x-ogc-unit': 'h'
        }

        print("JJJ")
        return self._fields

    def instances(self):
        print("INS")
        def f(d_):
          return d_.stem[:12]

        datadir = Path(self.data).parent
        dirs_ = sorted([f(d) for d in datadir.iterdir() if d.suffix == '.zarr'], reverse=True)
        return dirs_

    def get_instance(self, instance_id):
        if instance_id not in self.instances():
            return False

        return True

    def position(self, **kwargs):
        if kwargs.get('instance') is None:
            kwargs['instance'] = self.instances()[-1]
        else:
            if not self.get_instance(kwargs['instance']):
                raise ProviderInvalidDataError(user_msg='Invalid instance')
        self._fields.pop('instance_id')
        self._fields.pop('datetime')
        return super().position(**kwargs)


class MSCVOFMapProvider(BaseProvider):
    def __init__(self, provider_def):
        super().__init__(provider_def)
        self.data2 = self.data

        self.dpi = 100
        self.squeeze = self.options.pop('squeeze', False)
        self.coastlines = self.options.pop('coastlines', False)

        if self.options:
            self.data = xr.open_dataset(self.data, **self.options)
        else:
            self.data = xr.open_dataset(self.data)

        if self.squeeze:
            self.data = self.data.squeeze()

        self._fields = self.get_fields()

    def get_fields(self):
        print("GET_FIELDS")
        if not self._fields:
            for key, value in self.data.variables.items():
                if key not in self.data.coords:
                    LOGGER.debug('Adding variable')
                    dtype = value.dtype
                    if dtype.name.startswith('float'):
                        dtype = 'float'
                    elif dtype.name.startswith('int'):
                        dtype = 'integer'
                    elif dtype.name.startswith('str'):
                        dtype = 'string'

                    self._fields[key] = {
                        'type': dtype,
                        'title': value.attrs.get('long_name'),
                        'x-ogc-unit': value.attrs.get('units')
                    }

        datadir = Path(self.data2).parent

        instance_ids = [d.stem[:12] for d in datadir.iterdir() if d.suffix == 'zarr']

        self._fields['instance_id'] = {
            'type':'string',
            'enum': instance_ids
        }

        print("JJJ")
        return self._fields

    def query(self, style=None, bbox=[], width=500, height=300, crs='CRS84',
              datetime_=None, format_='png', transparent=True, **kwargs):

        if 'select_properties' in kwargs:
            select_property = kwargs['select_properties'][0]
        else:
            select_property = 'AirTemp'

        print("DATA2", self.data2)
        xep = XarrayEDRProvider({'name': 'edr', 'type': 'edr', 'data': self.data2})
        if datetime_ is None:
            LOGGER.debug('Setting default time')
            datetime_ = str(self.data[self.time_field].values[0])

        if 'select_properties' in kwargs:
            select_property = kwargs['select_properties'][0]
        else:
            select_property = 'AirTemp'

        LOGGER.debug(f'Select property: {select_property}')

        query_params = {
            'rlat': slice(bbox[1], bbox[3]),
            'rlon': slice(bbox[0], bbox[2])
        }

        LOGGER.debug('Processing time field')
        if self.time_field in kwargs.get('subsets', {}):
            if len(kwargs['subsets'][self.time_field]) != 1:
                msg = 'Only single time allowed'
                raise ProviderInvalidDataError(user_msg=msg)

            query_params[self.time_field] = _mask_timestring(
                kwargs['subsets'][self.time_field])
        else:
            query_params[self.time_field] = _mask_timestring(datetime_)

        valid_time_values = [str(t) for t in self.data[self.time_field].values]  # noqa
        if query_params[self.time_field] not in valid_time_values:
            msg = f"Invalid datetime {query_params["time"]}; valid values are {valid_time_values}"
            raise ProviderInvalidDataError(user_msg=msg)

        LOGGER.debug(f'Query params: {query_params}')

        try:
            #response = self.data.sel(query_params)[select_property]
            response = xep.cube(bbox=bbox, query_type='cube', crs=crs, datetime_=datetime_, raw=True, select_properties=[select_property])
        except Exception as err:
            msg = 'Map could not be generated/no data'
            LOGGER.error(msg)
            raise ProviderInvalidDataError(user_msg=msg)

        LOGGER.debug('Query result')
        LOGGER.debug(response)

        fig = plt.figure(figsize=(width / self.dpi, height / self.dpi),
                         dpi=self.dpi)
        ax = plt.axes(projection=ccrs.PlateCarree())
        ax.set_position([0, 0, 1, 1])  # left, bottom, width, height (0–1)

        if self.coastlines:
            LOGGER.debug('Setting coastlines')
            ax.coastlines()

        ax.set_axis_off()
        ax.set_title(None)

#        print(type(response))
#        print(response.dtypes)
#        print(response.shape)
#        print(response)

        ax.imshow(
            response[select_property].values,
            origin='lower',
            extent=[bbox[0], bbox[2], bbox[1], bbox[3]],
            cmap='coolwarm',
            interpolation='nearest',
            aspect='auto'
        )

        buf = io.BytesIO()
        fig.savefig(buf, dpi=self.dpi, bbox_inches=None, pad_inches=0,
                    format='png')
        plt.close(fig)
        buf.seek(0)
        return buf


def _mask_timestring(value: str | None) -> str:
    """
    Convenience function to transform to MSC time convention
    """
    return value
    if value is not None:
        return value[:-4]
