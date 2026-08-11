extends Node
## Issue actions against ships (navigate, orbit, dock, mine, trade).
## All commands are fire-and-forget; errors are logged to GameState.

func _run(label: String, job: Callable) -> void:
	var res: Dictionary = await job.call()
	if res.get("ok", false):
		GameState.append_log("ok", "%s" % label)
	else:
		var status: int = res.get("status", 0)
		var message: String = _error_message(res)
		GameState.append_log("error", "%s: %s (HTTP %d)" % [label, message, status])
	await _refresh_ship(res)

func _refresh_ship(res: Dictionary) -> void:
	# The response may carry the updated ship directly (navigate/refuel/purchase).
	if res.get("data", {}).has("ship") or res.get("data", {}).has("nav") or res.get("data", {}).has("cargo"):
		await _refresh_all()

func _refresh_all() -> void:
	var ships_res := await Api.get_my_ships()
	if ships_res.get("ok", false):
		GameState.set_ships(ships_res["data"])

func _error_message(res: Dictionary) -> String:
	var data: Dictionary = res.get("data", {})
	var err: Dictionary = data.get("error", {})
	if err.has("message"):
		return str(err["message"])
	return str(data)

func navigate_to(ship_symbol: String, waypoint_symbol: String) -> void:
	_run("navigate %s → %s" % [ship_symbol, waypoint_symbol], func():
		return await Api.navigate(ship_symbol, waypoint_symbol))

func orbit_ship(ship_symbol: String) -> void:
	_run("orbit %s" % ship_symbol, func():
		return await Api.orbit(ship_symbol))

func dock_ship(ship_symbol: String) -> void:
	_run("dock %s" % ship_symbol, func():
		return await Api.dock(ship_symbol))

func extract(ship_symbol: String) -> void:
	_run("extract %s" % ship_symbol, func():
		return await Api.extract(ship_symbol))

func refuel_ship(ship_symbol: String) -> void:
	_run("refuel %s" % ship_symbol, func():
		return await Api.refuel(ship_symbol))

func buy(ship_symbol: String, good: String, units: int) -> void:
	_run("buy %d %s on %s" % [units, good, ship_symbol], func():
		return await Api.purchase(ship_symbol, good, units))

func sell_good(ship_symbol: String, good: String, units: int) -> void:
	_run("sell %d %s on %s" % [units, good, ship_symbol], func():
		return await Api.sell(ship_symbol, good, units))
