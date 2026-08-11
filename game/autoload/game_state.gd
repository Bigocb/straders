extends Node
## Shared game state: agent, ships, waypoints, systems, and the activity log.

var agent: Dictionary = {}
var ships: Array = []
var contracts: Array = []
var waypoints: Array = []        # {symbol, x, y, type, traits}
var systems: Array = []          # {symbol, waypoints, jumpGates}
var jump_connections: Array = [] # {from, to}
var activity_log: Array = []     # {timestamp, shipSymbol, kind, detail, credits}
var paused := false

signal state_updated
signal ship_updated(ship_symbol: String)
signal log_appended(entry: Dictionary)

func set_agent(a: Dictionary) -> void:
	agent = a
	state_updated.emit()

func set_ships(s: Array) -> void:
	ships = s
	state_updated.emit()

func set_world(wps: Array, sys: Array, jumps: Array) -> void:
	waypoints = wps
	systems = sys
	jump_connections = jumps
	state_updated.emit()

func set_contracts(c: Array) -> void:
	contracts = c
	state_updated.emit()

func append_log(kind: String, detail: String, credits: int = 0) -> void:
	var entry := {
		"timestamp": Time.get_datetime_string_from_system(),
		"kind": kind,
		"detail": detail,
		"credits": credits,
	}
	activity_log.push_front(entry)
	if activity_log.size() > 40:
		activity_log.resize(40)
	log_appended.emit(entry)

func waypoint_by_symbol(symbol: String) -> Dictionary:
	for w in waypoints:
		if w.get("symbol", "") == symbol:
			return w
	return {}

func ship_by_symbol(symbol: String) -> Dictionary:
	for s in ships:
		if s.get("symbol", "") == symbol:
			return s
	return {}

func ships_at_waypoint(symbol: String) -> Array:
	var out: Array = []
	for s in ships:
		if s.get("nav", {}).get("waypointSymbol", "") == symbol:
			out.append(s)
	return out

func system_symbol_of(waypoint_symbol: String) -> String:
	var parts := waypoint_symbol.split("-")
	if parts.size() >= 2:
		return parts[0] + "-" + parts[1]
	return ""
