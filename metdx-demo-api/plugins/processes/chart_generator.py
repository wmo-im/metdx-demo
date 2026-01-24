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

from datetime import datetime
import io

import matplotlib
import matplotlib.pyplot as plt
from pygeoapi.process.base import BaseProcessor, ProcessorExecuteError

matplotlib.use("Agg")

PROCESS_METADATA = {
    "version": "0.2.0",
    "id": "ChartProcessor",
    "title": {"en": "ChartProcessor"},
    "description": {
        "en": "An example process that takes a coverageJSON PointSeries as input, "  # noqa
        "and returns a timeseries chart. ",
    },
    "jobControlOptions": ["sync-execute", "async-execute"],
    "keywords": ["chart"],
    "links": [
        {
            "type": "text/html",
            "rel": "about",
            "title": "information",
            "href": "https://example.org/process",
            "hreflang": "en-US",
        }
    ],
    "inputs": {
        "coveragejson": {
            "title": "CoverageJSON",
            "description": "Input CoverageJSON object",
            "schema": {
                "type": "object",
                "contentMediaType": "application/json",
            },  # noqa
            "minOccurs": 1,
            "maxOccurs": 1,
        }
    },
    "outputs": {
        "chart": {
            "title": "Time series chart",
            "schema": {"type": "string", "contentMediaType": "image/png"},
        }
    },
    "example": {
        "inputs": {
            "name": "PointSeries CoverageJSON",
            "CoverageJSON": "PointSeries CoverageJSON.",
        }
    },
}


class ChartProcessor(BaseProcessor):
    """Chart process plugin"""

    def __init__(self, processor_def):
        """
        Initialize object

        :param processor_def: provider definition

        :returns: pygeoapi.process.chart_generator.ChartProcessor
        """

        super().__init__(processor_def, PROCESS_METADATA)

    def execute(self, data, outputs=None):

        cov = data.get("CoverageJSON")
        if cov is None:
            raise ProcessorExecuteError("coveragejson input is required")

        try:
            # --- Extract axes ---
            axes = cov["domain"]["axes"]
            times = axes["t"]["values"]

            # --- Extract first (or named) range ---
            # Here we assume a single range called "2t"
            range_name, range_obj = next(iter(cov["ranges"].items()))
            values = range_obj["values"]

        except Exception as err:
            msg = f"Invalid CoverageJSON structure: {err}"
            raise ProcessorExecuteError(msg)

        # --- Convert ISO8601 times to datetime ---
        x = [datetime.fromisoformat(t.replace("Z", "+00:00")) for t in times]
        y = values

        # --- Create the plot ---
        fig, ax = plt.subplots(figsize=(10, 4))
        ax.plot(x, y, marker="o", linewidth=1)

        ax.set_title(f"Time series for {range_name}")
        ax.set_xlabel("Time")
        ax.set_ylabel("Value")
        ax.grid(True)

        fig.autofmt_xdate()

        # --- Write PNG to memory ---
        buf = io.BytesIO()
        fig.savefig(buf, format="png", dpi=150, bbox_inches="tight")
        plt.close(fig)
        buf.seek(0)

        png_bytes = buf.read()

        return "image/png", png_bytes

    def __repr__(self):
        return f"<Chart_Plugin> {self.name}"
