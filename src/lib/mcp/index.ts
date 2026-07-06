import { defineMcp } from "@lovable.dev/mcp-js";
import listRecentSignals from "./tools/list-recent-signals";
import signalStats from "./tools/signal-stats";
import getScanGates from "./tools/get-scan-gates";

export default defineMcp({
  name: "scalpedge-mcp",
  title: "ScalpEdge MCP",
  version: "0.1.0",
  instructions:
    "Read-only tools for the ScalpEdge forex scalping signal system. Use `list_recent_signals` to inspect the latest signals, `signal_stats` for rolling performance, and `get_scan_gates` to see the active filter thresholds the scan engine is using.",
  tools: [listRecentSignals, signalStats, getScanGates],
});
