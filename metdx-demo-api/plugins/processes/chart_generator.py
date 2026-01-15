from pygeoapi.process.base import BaseProcessor, ProcessorExecuteError

import io
import matplotlib

matplotlib.use("Agg")

import matplotlib.pyplot as plt
from pygeoapi.process.base import ProcessorExecuteError
from datetime import datetime

PROCESS_METADATA = {
    "version": "0.2.0",
    "id": "ChartProcessor",
    "title": {"en": "ChartProcessor"},
    "description": {
        "en": "An example process that takes a name as input, and echoes "
        "it back as output. Intended to demonstrate a simple "
        "process with a single literal input.",
        "fr": "Un exemple de processus qui prend un nom en entrée et le "
        "renvoie en sortie. Destiné à démontrer un processus "
        "simple avec une seule entrée littérale.",
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
            "schema": {"type": "object", "contentMediaType": "application/json"},
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
            "message": "PointSeries CoverageJSON.",
        }
    },
}


class ChartProcessor(BaseProcessor):
    """Chart process plugin"""

    def __init__(self, processor_def):
        """
        Initialize object

        :param processor_def: provider definition

        :returns: pygeoapi.process.mycoolsqrtprocess.MyCoolSqrtProcessor
        """

        super().__init__(processor_def, PROCESS_METADATA)

    def execute(self, data, outputs=None):

        cov = data.get("coveragejson")
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
            raise ProcessorExecuteError(f"Invalid CoverageJSON structure: {err}")

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
