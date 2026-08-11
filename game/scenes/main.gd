extends Control
## Main loop: boot → fetch world → poll ships → render.
## Ships are clickable; clicking a waypoint navigates the selected ship there.
## Ship icons glide to new positions for a lightweight flight animation.

const TICK_INTERVAL := 5.0

var selected_ship: String = ""
var ship_icons: Dictionary = {}        # ship_symbol -> Polygon2D
var ship_anim_from: Dictionary = {}    # ship_symbol -> Vector2
var ship_anim_to: Dictionary = {}      # ship_symbol -> Vector2
var ship_anim_t: Dictionary = {}       # ship_symbol -> float
var wp_nodes: Dictionary = {}          # waypoint_symbol -> Node2D
var gate_lines: Array = []             # [Line2D]
var cam_offset := Vector2.ZERO
var drag_start := Vector2.ZERO
var dragging := false

@onready var waypoint_layer: Node2D = $MapCanvas/Waypoints
@onready var ship_layer: Node2D = $MapCanvas/Ships
@onready var route_layer: Node2D = $MapCanvas/Routes
@onready var star_layer: Node2D = $MapCanvas/Stars
@onready var system_label: Label = $MapCanvas/SystemLabel
@onready var credits_label: Label = $HUD/TopBar/Margin/Row/Credits
@onready var ships_label: Label = $HUD/TopBar/Margin/Row/ShipCount
@onready var mode_label: Label = $HUD/TopBar/Margin/Row/Mode
@onready var ship_list: VBoxContainer = $HUD/RightPanel/Margin/VBox/ShipList
@onready var log_view: RichTextLabel = $HUD/RightPanel/Margin/VBox/Log

func _ready() -> void:
	_generate_stars()
	GameState.log_appended.connect(_on_log_appended)
	GameState.state_updated.connect(_on_state_updated)
	_build_inspector()
	_boot()

func _boot() -> void:
	GameState.append_log("info", "Booting StarTraders Command…")
	if not Api.has_token():
		GameState.append_log("warn", "No agent token found — read-only demo mode.")
		return
	var agent_res := await Api.get_my_agent()
	if agent_res.get("ok", false):
		GameState.set_agent(agent_res["data"])
		GameState.append_log("info", "Connected as " + str(GameState.agent.get("symbol", "?")))
	else:
		GameState.append_log("error", "Failed to connect: " + str(agent_res.get("data", {})))
		return

	var hq: String = str(GameState.agent.get("headquarters", ""))
	var home_system: String = _system_of(hq)
	system_label.text = "SYSTEM " + home_system

	await _load_system(home_system)
	await _refresh_ships()
	_tick_loop()

func _tick_loop() -> void:
	while true:
		await get_tree().create_timer(TICK_INTERVAL).timeout
		if GameState.paused:
			continue
		await _refresh_ships()

func _system_of(waypoint_symbol: String) -> String:
	var parts := waypoint_symbol.split("-")
	if parts.size() >= 2:
		return parts[0] + "-" + parts[1]
	return waypoint_symbol

func _load_system(system_symbol: String) -> void:
	GameState.append_log("info", "Loading system %s…" % system_symbol)
	var wp_res := await Api.get_system_waypoints(system_symbol)
	if not wp_res.get("ok", false):
		GameState.append_log("error", "Failed to load waypoints.")
		return
	GameState.set_world(wp_res["data"], [], [])
	_render_waypoints()
	await _scan_jump_gates(system_symbol)

func _scan_jump_gates(system_symbol: String) -> void:
	var connections: Array = []
	for w in GameState.waypoints:
		if w.get("type", "") != "JUMP_GATE":
			continue
		var res := await Api.get_jump_gate(system_symbol, w.get("symbol", ""))
		if not res.get("ok", false):
			continue
		var data: Dictionary = res.get("data", {})
		for c in data.get("connections", []):
			connections.append({"from": w.get("symbol", ""), "to": str(c)})
	GameState.jump_connections = connections
	_render_gates()

func _refresh_ships() -> void:
	var res := await Api.get_my_ships()
	if not res.get("ok", false):
		return
	GameState.set_ships(res["data"])
	_render_ships()
	_update_hud()
	if selected_ship != "" and not _ship_exists(selected_ship):
		selected_ship = ""
	_update_inspector()

func _render_waypoints() -> void:
	for child in waypoint_layer.get_children():
		child.queue_free()
	wp_nodes.clear()
	for w in GameState.waypoints:
		var symbol: String = w.get("symbol", "")
		var pos := _world_to_screen(Vector2(w.get("x", 0.0), w.get("y", 0.0)))
		var traits: Array = w.get("traits", [])
		var type_str: String = w.get("type", "")
		var color := Color(0.55, 0.62, 0.70)
		var radius := 4.0
		if traits.has("MARKETPLACE"):
			color = Color(1.0, 0.62, 0.26)
			radius = 6.0
		elif type_str in ["ASTEROID", "ASTEROID_FIELD", "ENGINEERED_ASTEROID"]:
			color = Color(0.45, 0.55, 0.65)
			radius = 5.0
		elif type_str == "JUMP_GATE":
			color = Color(0.31, 0.82, 0.77)
			radius = 5.0
		var node := Node2D.new()
		node.position = pos
		node.name = symbol
		# Larger invisible hit area for clicking.
		var hit := Area2D.new()
		var shape := CollisionShape2D.new()
		var circle := CircleShape2D.new()
		circle.radius = 14.0
		shape.shape = circle
		hit.add_child(shape)
		hit.input_pickable = true
		hit.name = "Hit"
		hit.mouse_entered.connect(func(): _hover_waypoint(symbol, true))
		hit.mouse_exited.connect(func(): _hover_waypoint(symbol, false))
		hit.input_event.connect(func(_v: Node, event: InputEvent, _id: int): _waypoint_input(symbol, event))
		node.add_child(hit)
		var dot := Polygon2D.new()
		dot.polygon = PackedVector2Array([Vector2(0, -radius), Vector2(radius, 0), Vector2(0, radius), Vector2(-radius, 0)])
		dot.color = color
		node.add_child(dot)
		node.z_index = 0
		waypoint_layer.add_child(node)
		wp_nodes[symbol] = node
		if traits.has("MARKETPLACE") or type_str == "JUMP_GATE":
			var label := Label.new()
			label.text = _short_wp(symbol)
			label.position = Vector2(8, -7)
			label.add_theme_font_size_override("font_size", 12)
			label.add_theme_color_override("font_color", Color(0.5, 0.55, 0.6))
			node.add_child(label)


func _render_gates() -> void:
	for line in gate_lines:
		if is_instance_valid(line):
			line.queue_free()
	gate_lines.clear()
	# Connect gates across known systems via the game_state jump connections if present.
	for conn in GameState.jump_connections:
		var a := GameState.waypoint_by_symbol(conn.get("from", ""))
		var b := GameState.waypoint_by_symbol(conn.get("to", ""))
		if a.is_empty() or b.is_empty():
			continue
		var line := Line2D.new()
		line.points = PackedVector2Array([
			_world_to_screen(Vector2(a.get("x", 0.0), a.get("y", 0.0))),
			_world_to_screen(Vector2(b.get("x", 0.0), b.get("y", 0.0))),
		])
		line.width = 1.0
		line.default_color = Color(0.31, 0.82, 0.77, 0.4)
		line.dashed = true
		line.dash_length = 4.0
		route_layer.add_child(line)
		gate_lines.append(line)

func _render_ships() -> void:
	# Remove stale icons.
	for symbol in ship_icons.keys():
		if not _ship_exists(symbol):
			ship_icons[symbol].queue_free()
			ship_icons.erase(symbol)
			ship_anim_from.erase(symbol)
			ship_anim_to.erase(symbol)
			ship_anim_t.erase(symbol)
	for s in GameState.ships:
		var symbol: String = s.get("symbol", "")
		var wp: String = s.get("nav", {}).get("waypointSymbol", "")
		var wp_pos: Dictionary = GameState.waypoint_by_symbol(wp)
		if wp_pos.is_empty():
			continue
		var target := _world_to_screen(Vector2(wp_pos.get("x", 0.0), wp_pos.get("y", 0.0)))
		if not ship_icons.has(symbol):
			var icon := Polygon2D.new()
			icon.polygon = PackedVector2Array([Vector2(0, -8), Vector2(7, 7), Vector2(0, 2), Vector2(-7, 7)])
			icon.color = Color(1.0, 0.62, 0.26)
			icon.z_index = 2
			ship_layer.add_child(icon)
			ship_icons[symbol] = icon
			ship_anim_from[symbol] = target
			ship_anim_to[symbol] = target
			ship_anim_t[symbol] = 1.0
		# If target moved significantly, start a glide animation.
		var prev: Vector2 = ship_anim_to.get(symbol, target)
		if prev.distance_to(target) > 2.0:
			ship_anim_from[symbol] = ship_icons[symbol].position
			ship_anim_to[symbol] = target
			ship_anim_t[symbol] = 0.0
		elif ship_anim_t.get(symbol, 1.0) >= 1.0:
			ship_icons[symbol].position = target
			ship_anim_to[symbol] = target

func _process(delta: float) -> void:
	# Glide ship icons toward their targets.
	for symbol in ship_icons.keys():
		var t: float = ship_anim_t.get(symbol, 1.0)
		if t < 1.0:
			t = minf(1.0, t + delta * 2.0)
			ship_anim_t[symbol] = t
			var from: Vector2 = ship_anim_from.get(symbol, Vector2.ZERO)
			var to: Vector2 = ship_anim_to.get(symbol, Vector2.ZERO)
			ship_icons[symbol].position = from.lerp(to, ease(t, 0.35))

func _ship_exists(symbol: String) -> bool:
	for s in GameState.ships:
		if s.get("symbol", "") == symbol:
			return true
	return false

func _update_hud() -> void:
	credits_label.text = "Credits: " + _fmt(GameState.agent.get("credits", 0))
	ships_label.text = "Ships: " + str(GameState.ships.size())
	mode_label.text = "HALTED" if GameState.paused else "AUTO"
	_render_ship_list()

func _render_ship_list() -> void:
	for child in ship_list.get_children():
		child.queue_free()
	for s in GameState.ships:
		var symbol: String = s.get("symbol", "")
		var status: String = s.get("nav", {}).get("status", "")
		var wp_symbol: String = s.get("nav", {}).get("waypointSymbol", "")
		var wp: String = _short_wp(wp_symbol)
		var sys: String = GameState.system_symbol_of(wp_symbol)
		var fuel: Dictionary = s.get("fuel", {})
		var cargo: Dictionary = s.get("cargo", {})
		var row := Button.new()
		row.text = "%s  %s · %s · %s   %d/%d ⛽ %d/%d" % [
			symbol, status, sys, wp,
			fuel.get("current", 0), fuel.get("capacity", 0),
			cargo.get("units", 0), cargo.get("capacity", 0),
		]
		row.add_theme_font_size_override("font_size", 10)
		row.add_theme_color_override("font_color", Color(1.0, 0.62, 0.26))
		row.add_theme_stylebox_override("normal", _row_style(0.0))
		row.add_theme_stylebox_override("hover", _row_style(0.1))
		row.add_theme_stylebox_override("pressed", _row_style(0.15))
		row.add_theme_stylebox_override("focus", _row_style(0.0))
		row.alignment = HORIZONTAL_ALIGNMENT_LEFT
		row.pressed.connect(_select_ship.bind(symbol))
		if symbol == selected_ship:
			row.modulate = Color(1.3, 1.0, 0.6)
		ship_list.add_child(row)

func _row_style(alpha: float) -> StyleBoxFlat:
	var sb := StyleBoxFlat.new()
	sb.bg_color = Color(1.0, 0.62, 0.26, alpha)
	sb.set_border_width_all(1)
	sb.border_color = Color(1.0, 0.62, 0.26, 0.3)
	sb.set_corner_radius_all(2)
	return sb

func _select_ship(symbol: String) -> void:
	selected_ship = symbol
	_update_inspector()
	_render_ship_list()

func _on_log_appended(_entry: Dictionary) -> void:
	log_view.append_text(_entry.get("detail", "") + "\n")
	while log_view.get_line_count() > 40:
		log_view.remove_paragraph(0)

func _on_state_updated() -> void:
	_update_hud()

func _generate_stars() -> void:
	for i in 140:
		var star := Polygon2D.new()
		var r := randf_range(0.5, 1.6)
		star.polygon = PackedVector2Array([Vector2(0, -r), Vector2(r, 0), Vector2(0, r), Vector2(-r, 0)])
		var bright := randf_range(0.2, 0.7)
		star.color = Color(bright, bright, bright, 0.6)
		star.position = Vector2(randf_range(0, 1280), randf_range(0, 800))
		star_layer.add_child(star)

func _world_to_screen(p: Vector2) -> Vector2:
	const SCALE := 1.1
	return p * SCALE + cam_offset + Vector2(60, 60)

func _short_wp(symbol: String) -> String:
	var parts := symbol.split("-")
	if parts.size() > 0:
		return parts[parts.size() - 1]
	return symbol

func _fmt(n) -> String:
	return str(int(n))

# ── interaction ───────────────────────────────────
var hovered_wp := ""

func _hover_waypoint(symbol: String, on: bool) -> void:
	if on:
		hovered_wp = symbol
		var node: Node2D = wp_nodes.get(symbol, null)
		if node != null and node.get_child_count() > 1:
			var dot := node.get_child(1) as Polygon2D
			if dot != null:
				dot.scale = Vector2(1.6, 1.6)
	else:
		if hovered_wp == symbol:
			hovered_wp = ""
		var node: Node2D = wp_nodes.get(symbol, null)
		if node != null and node.get_child_count() > 1:
			var dot := node.get_child(1) as Polygon2D
			if dot != null:
				dot.scale = Vector2.ONE

func _waypoint_input(symbol: String, event: InputEvent) -> void:
	if event is InputEventMouseButton and event.button_index == MOUSE_BUTTON_LEFT and event.pressed:
		_navigate_selected(symbol)

func _navigate_selected(waypoint: String) -> void:
	if selected_ship == "":
		return
	Commands.navigate_to(selected_ship, waypoint)
	GameState.append_log("cmd", "order %s → %s" % [selected_ship, waypoint])

func _input(event: InputEvent) -> void:
	if event is InputEventMouseButton and event.pressed:
		if event.button_index == MOUSE_BUTTON_WHEEL_UP:
			cam_offset += Vector2(-8, -8)
			_refresh_positions()
		elif event.button_index == MOUSE_BUTTON_WHEEL_DOWN:
			cam_offset += Vector2(8, 8)
			_refresh_positions()
		elif event.button_index == MOUSE_BUTTON_LEFT:
			dragging = true
			drag_start = event.position
	elif event is InputEventMouseButton and not event.pressed:
		if event.button_index == MOUSE_BUTTON_LEFT:
			dragging = false
	elif event is InputEventMouseMotion and dragging:
		cam_offset += event.position - drag_start
		drag_start = event.position
		_refresh_positions()

func _refresh_positions() -> void:
	for w in GameState.waypoints:
		var node: Node2D = wp_nodes.get(w.get("symbol", ""), null)
		if node != null:
			node.position = _world_to_screen(Vector2(w.get("x", 0.0), w.get("y", 0.0)))
	for line in gate_lines:
		if is_instance_valid(line):
			line.queue_free()
	gate_lines.clear()
	_render_gates()
	# Rebase ship glide targets to the new projection.
	for symbol in ship_icons.keys():
		if not ship_anim_to.has(symbol):
			continue
		var s := GameState.ship_by_symbol(symbol)
		if not s.is_empty():
			var wp_pos: Dictionary = GameState.waypoint_by_symbol(s.get("nav", {}).get("waypointSymbol", ""))
			if not wp_pos.is_empty():
				ship_anim_to[symbol] = _world_to_screen(Vector2(wp_pos.get("x", 0.0), wp_pos.get("y", 0.0)))
				ship_anim_from[symbol] = ship_icons[symbol].position
				ship_anim_t[symbol] = 0.0

# ── inspector panel ───────────────────────────────
var inspector: PanelContainer
var insp_ship_label: Label
var insp_meta_label: Label
var insp_btn_orbit: Button
var insp_btn_dock: Button
var insp_btn_mine: Button
var insp_btn_refuel: Button

func _build_inspector() -> void:
	inspector = PanelContainer.new()
	inspector.name = "Inspector"
	inspector.visible = false
	inspector.set_anchors_preset(Control.PRESET_BOTTOM_LEFT)
	inspector.anchor_left = 0.0
	inspector.anchor_top = 1.0
	inspector.anchor_right = 0.0
	inspector.anchor_bottom = 1.0
	inspector.offset_left = 8.0
	inspector.offset_top = -190.0
	inspector.offset_right = 320.0
	inspector.offset_bottom = -8.0
	var sb := StyleBoxFlat.new()
	sb.bg_color = Color(0.07, 0.09, 0.12, 0.92)
	sb.set_border_width_all(1)
	sb.border_color = Color(1.0, 0.62, 0.26, 0.5)
	sb.set_corner_radius_all(3)
	inspector.add_theme_stylebox_override("panel", sb)
	add_child(inspector)

	var margin := MarginContainer.new()
	margin.add_theme_constant_override("margin_left", 12)
	margin.add_theme_constant_override("margin_top", 8)
	margin.add_theme_constant_override("margin_right", 12)
	margin.add_theme_constant_override("margin_bottom", 8)
	inspector.add_child(margin)

	var box := VBoxContainer.new()
	box.add_theme_constant_override("separation", 6)
	margin.add_child(box)

	insp_ship_label = Label.new()
	insp_ship_label.add_theme_font_size_override("font_size", 16)
	box.add_child(insp_ship_label)

	insp_meta_label = Label.new()
	insp_meta_label.add_theme_font_size_override("font_size", 11)
	insp_meta_label.add_theme_color_override("font_color", Color(0.55, 0.62, 0.7))
	box.add_child(insp_meta_label)

	var row := HBoxContainer.new()
	row.add_theme_constant_override("separation", 6)
	box.add_child(row)

	insp_btn_orbit = _action_button("Orbit")
	insp_btn_orbit.pressed.connect(func(): Commands.orbit_ship(selected_ship))
	row.add_child(insp_btn_orbit)

	insp_btn_dock = _action_button("Dock")
	insp_btn_dock.pressed.connect(func(): Commands.dock_ship(selected_ship))
	row.add_child(insp_btn_dock)

	insp_btn_mine = _action_button("Mine")
	insp_btn_mine.pressed.connect(func(): Commands.extract(selected_ship))
	row.add_child(insp_btn_mine)

	insp_btn_refuel = _action_button("Refuel")
	insp_btn_refuel.pressed.connect(func(): Commands.refuel_ship(selected_ship))
	row.add_child(insp_btn_refuel)

func _action_button(text: String) -> Button:
	var b := Button.new()
	b.text = text
	b.add_theme_font_size_override("font_size", 10)
	var sb := StyleBoxFlat.new()
	sb.bg_color = Color(0.13, 0.16, 0.22)
	sb.set_border_width_all(1)
	sb.border_color = Color(1.0, 0.62, 0.26, 0.4)
	sb.set_corner_radius_all(2)
	b.add_theme_stylebox_override("normal", sb)
	b.add_theme_stylebox_override("hover", sb)
	b.add_theme_stylebox_override("pressed", sb)
	return b

func _update_inspector() -> void:
	if selected_ship == "" or inspector == null:
		if inspector != null:
			inspector.visible = false
		return
	var s := GameState.ship_by_symbol(selected_ship)
	if s.is_empty():
		inspector.visible = false
		return
	inspector.visible = true
	insp_ship_label.text = selected_ship
	insp_meta_label.text = "%s · %s · %s\nfuel %d/%d · cargo %d/%d" % [
		s.get("registration", {}).get("role", "?"),
		s.get("nav", {}).get("status", "?"),
		_short_wp(s.get("nav", {}).get("waypointSymbol", "")),
		s.get("fuel", {}).get("current", 0), s.get("fuel", {}).get("capacity", 0),
		s.get("cargo", {}).get("units", 0), s.get("cargo", {}).get("capacity", 0),
	]
