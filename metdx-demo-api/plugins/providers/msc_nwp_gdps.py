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

import cartopy.crs as ccrs
import matplotlib
import matplotlib.pyplot as plt
import xarray as xr

from pygeoapi.provider.base import BaseProvider, ProviderInvalidDataError
from pygeoapi.provider.xarray_edr import XarrayEDRProvider


matplotlib.use('Agg')

LOGGER = logging.getLogger(__name__)


class MSCNWPGDPSEDRProvider(XarrayEDRProvider):
    def __init__(self, provider_def):
        super().__init__(provider_def)

    def get_instances(self):
        return ['20251028T00Z']

    def get_instance(self, instance_id):
        return True

    def position(self, **kwargs):
        return super().position(**kwargs)


class MSCNWPGDPSMapProvider(BaseProvider):
    def __init__(self, provider_def):
        super().__init__(provider_def)

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

        return self._fields

    def query(self, style=None, bbox=[], width=500, height=300, crs='CRS84',
              datetime_=None, format_='png', transparent=True, **kwargs):

        if datetime_ is None:
            LOGGER.debug('Setting default time')
            datetime_ = str(self.data[self.time_field].values[0])

        if 'select_properties' in kwargs:
            select_property = kwargs['select_properties'][0]
        else:
            select_property = 'AirTemp'

        LOGGER.debug(f'Select property: {select_property}')

        query_params = {
            'lat': slice(bbox[1], bbox[3]),
            'lon': slice(bbox[0], bbox[2]),
            'vertical': 0
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

        valid_time_values = [str(t)[:16] for t in self.data[self.time_field].values]  # noqa
        if query_params[self.time_field][:16] not in valid_time_values:
            msg = f'Invalid datetime; valid values are {valid_time_values}'
            raise ProviderInvalidDataError(user_msg=msg)

        LOGGER.debug('Processing z field')
        if self.z_field in kwargs.get('subsets', {}):
            if len(kwargs['subsets'][self.z_field]) != 1:
                msg = 'Only single z allowed'
                raise ProviderInvalidDataError(user_msg=msg)

            query_params[self.z_field] = kwargs['subsets'][self.z_field][0]
        else:
            query_params[self.z_field] = 0

        if query_params[self.z_field] not in self.data[self.z_field].values:
            msg = f'Invalid z; valid values are {self.data[self.z_field].values}'  # noqa
            raise ProviderInvalidDataError(user_msg=msg)

        LOGGER.debug(f'Query params: {query_params}')

        try:
            response = self.data.sel(query_params)[select_property]
        except Exception as err:
            msg = f'Invalid query {err}'
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

        ax.imshow(
            response.values,
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

    if value is not None:
        return value[:-4]
