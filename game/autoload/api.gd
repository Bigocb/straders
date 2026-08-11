extends Node
## HTTP client for the SpaceTraders v2 API.
## Reads the agent token from a local file so the game can act on the same
## account as the web command center.

const BASE_URL := "https://api.spacetraders.io/v2"
const TOKEN_FILE := "user://st-token.txt"

var token: String = ""
var rate_bucket := 2.0  # per-second allowance; SpaceTraders enforces 2 req/s
var last_fill := 0.0

func _ready() -> void:
	last_fill = Time.get_ticks_msec() / 1000.0
	# Load a CA bundle so HTTPS works on systems without Godot's default store.
	var ca_file := FileAccess.open("res://certificates/Godot_cert.pem", FileAccess.READ)
	if ca_file != null:
		ProjectSettings.set_setting("network/tls/certificate_bundle_override", "res://certificates/Godot_cert.pem")
		ca_file.close()
	_load_token()

func _load_token() -> void:
	# Try the user-data location first (set by the game or the player).
	var f := FileAccess.open(TOKEN_FILE, FileAccess.READ)
	if f != null:
		token = f.get_as_text().strip_edges()
		f.close()
		if token != "":
			print("Loaded agent token from ", TOKEN_FILE)
			return
	# Fall back to the web app's token in the repo root.
	var repo_token := "res://../.st-token"
	f = FileAccess.open(repo_token, FileAccess.READ)
	if f != null:
		token = f.get_as_text().strip_edges()
		f.close()
		if token != "":
			print("Loaded agent token from ", repo_token)
			return
	push_warning("No token at %s or %s — game will run in read-only demo mode." % [TOKEN_FILE, repo_token])

func has_token() -> bool:
	return token != ""

## Wait until we have a free rate-limit slot.
func _throttle() -> void:
	var now := Time.get_ticks_msec() / 1000.0
	rate_bucket = minf(2.0, rate_bucket + (now - last_fill))
	last_fill = now
	if rate_bucket >= 1.0:
		rate_bucket -= 1.0
		return
	await get_tree().create_timer(1.0 - rate_bucket).timeout
	rate_bucket = 0.0
	last_fill = Time.get_ticks_msec() / 1000.0

## Generic request. Returns {ok, status, data} as a Dictionary.
func request(method: String, path: String, body: Dictionary = {}) -> Dictionary:
	await _throttle()
	var http := HTTPRequest.new()
	add_child(http)
	var url := BASE_URL + path
	var headers := PackedStringArray()
	if token != "":
		headers.append("Authorization: Bearer " + token)
	if not body.is_empty():
		headers.append("Content-Type: application/json")
	var http_method := HTTPClient.METHOD_GET if method == "GET" else HTTPClient.METHOD_POST
	var body_string := "" if method == "GET" or body.is_empty() else JSON.stringify(body)
	var err := http.request(url, headers, http_method, body_string)
	var response: Array = await http.request_completed
	http.queue_free()
	if err != OK or response.size() < 4:
		return {"ok": false, "status": 0, "data": {}}
	var code: int = response[1]
	var body_text: String = response[3].get_string_from_utf8()
	if not body_text.begins_with("{"):
		push_warning("API returned non-JSON (HTTP %d): %s" % [code, body_text.left(120)])
	var parsed: Variant = JSON.parse_string(body_text)
	if parsed == null:
		return {"ok": false, "status": code, "data": {}}
	if code < 200 or code >= 300:
		var err_data: Dictionary = parsed
		return {"ok": false, "status": code, "data": err_data}
	if parsed is Dictionary and parsed.has("data"):
		return {"ok": true, "status": code, "data": parsed["data"]}
	return {"ok": true, "status": code, "data": parsed}

func get_my_agent() -> Dictionary:
	return await request("GET", "/my/agent")

func get_my_ships() -> Dictionary:
	return await request("GET", "/my/ships?limit=20&page=1")

func get_contracts() -> Dictionary:
	return await request("GET", "/my/contracts?limit=20")

func get_system(system_symbol: String) -> Dictionary:
	return await request("GET", "/systems/%s" % system_symbol)

func get_system_waypoints(system_symbol: String) -> Dictionary:
	return await request("GET", "/systems/%s/waypoints?limit=20&page=1" % system_symbol)

func get_market(system_symbol: String, waypoint_symbol: String) -> Dictionary:
	return await request("GET", "/systems/%s/waypoints/%s/market" % [system_symbol, waypoint_symbol])

func get_jump_gate(system_symbol: String, waypoint_symbol: String) -> Dictionary:
	return await request("GET", "/systems/%s/waypoints/%s/jump-gate" % [system_symbol, waypoint_symbol])

func get_ship(ship_symbol: String) -> Dictionary:
	return await request("GET", "/my/ships/%s" % ship_symbol)

func navigate(ship_symbol: String, waypoint_symbol: String) -> Dictionary:
	return await request("POST", "/my/ships/%s/navigate" % ship_symbol, {"waypointSymbol": waypoint_symbol})

func orbit(ship_symbol: String) -> Dictionary:
	return await request("POST", "/my/ships/%s/orbit" % ship_symbol)

func dock(ship_symbol: String) -> Dictionary:
	return await request("POST", "/my/ships/%s/dock" % ship_symbol)

func extract(ship_symbol: String) -> Dictionary:
	return await request("POST", "/my/ships/%s/extract" % ship_symbol)

func refuel(ship_symbol: String) -> Dictionary:
	return await request("POST", "/my/ships/%s/refuel" % ship_symbol)

func purchase(ship_symbol: String, symbol: String, units: int) -> Dictionary:
	return await request("POST", "/my/ships/%s/purchase" % ship_symbol, {"symbol": symbol, "units": units})

func sell(ship_symbol: String, symbol: String, units: int) -> Dictionary:
	return await request("POST", "/my/ships/%s/sell" % ship_symbol, {"symbol": symbol, "units": units})
