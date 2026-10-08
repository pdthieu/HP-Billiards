package game

import "math"

// rackOrder lists ball ids row by row from the apex. The 8-ball is in the
// center of the triangle and the two back corners hold one solid and one stripe.
var rackOrder = [15]int{
	1,
	9, 2,
	10, 8, 3,
	11, 4, 12, 5,
	6, 13, 7, 14, 15,
}

// nineRack lists the 9-ball diamond row by row from the apex: the 1-ball on
// the foot spot, the 9-ball in the centre (WPA 5.1).
var nineRack = [][]int{{1}, {2, 3}, {4, 9, 5}, {6, 7}, {8}}

// segment is a straight piece of cushion rubber: a rail between two pocket
// noses, or a jaw leading from a nose into a pocket. Balls bounce off it,
// including off its end points, which is what makes a ball rattle in the jaws.
type segment struct {
	a, b   Vec
	inward Vec // unit normal toward the playing surface; used only when a center lies on the line
}

// pocket is the drop zone behind a pocket mouth. A ball is pocketed once its
// center is shelf past the mouth line, measured along axis.
type pocket struct {
	mouth Vec     // middle of the line between the two noses
	axis  Vec     // unit vector from the table into the pocket
	half  float64 // half the mouth width
	shelf float64
}

// Table is the physics world: the balls and the events of the current shot.
// It is not safe for concurrent use; the owning room goroutine drives it.
type Table struct {
	Cfg   Config
	Balls [NumBalls]Ball // indexed by ball id
	// Events accumulates what happened since the last Shoot (or ClearEvents).
	Events []Event
	// Collided reports whether the last Step had a ball bounce off a ball or
	// a cushion: a corner in some ball's path worth a snapshot of its own.
	Collided bool
	// Clock is the simulated time since the last Shoot (or ClearEvents) and
	// Impacts the audible contacts since then, in order.
	Clock   float64
	Impacts []Impact

	pockets      [NumPockets]pocket
	segments     []segment // 6 cushions and 12 jaws
	firstContact bool      // the cue ball has already touched an object ball this shot
	crossedHead  bool      // the cue ball has already crossed the head string this shot
}

// NewTable returns a racked table ready for the break.
func NewTable(cfg Config) *Table {
	t := &Table{Cfg: cfg}
	t.buildRails()
	t.Rack()
	return t
}

// buildRails lays out the cushions, jaws and drop zones from Cfg.
//
// The corner noses sit CornerMouth/√2 from the corner along each rail, so the
// mouth line between them (at 45°) is CornerMouth long. The side noses sit
// SideMouth/2 either side of the rail's middle.
func (t *Table) buildRails() {
	cfg := t.Cfg
	w, h := cfg.TableWidth, cfg.TableHeight
	a := cfg.CornerMouth / math.Sqrt2
	s := cfg.SideMouth / 2
	d := 1 / math.Sqrt2

	// Order defines the pocket index used in events and calls.
	t.pockets = [NumPockets]pocket{
		{Vec{a / 2, a / 2}, Vec{-d, -d}, cfg.CornerMouth / 2, cfg.CornerShelf},
		{Vec{w / 2, 0}, Vec{0, -1}, s, cfg.SideShelf},
		{Vec{w - a/2, a / 2}, Vec{d, -d}, cfg.CornerMouth / 2, cfg.CornerShelf},
		{Vec{a / 2, h - a/2}, Vec{-d, d}, cfg.CornerMouth / 2, cfg.CornerShelf},
		{Vec{w / 2, h}, Vec{0, 1}, s, cfg.SideShelf},
		{Vec{w - a/2, h - a/2}, Vec{d, d}, cfg.CornerMouth / 2, cfg.CornerShelf},
	}

	t.segments = t.segments[:0]
	// cushion adds a rail between two noses and the jaw at each end. corner
	// says which end (a or b) meets a corner pocket; the other meets a side
	// pocket or, for the short rails, both ends are corners.
	cushion := func(from, to, inward Vec, fromCorner, toCorner bool) {
		t.segments = append(t.segments, segment{from, to, inward})
		dir := to.Sub(from)
		dir = dir.Scale(1 / dir.Len())
		t.segments = append(t.segments, t.jaw(from, dir, inward, fromCorner))
		t.segments = append(t.segments, t.jaw(to, dir.Scale(-1), inward, toCorner))
	}
	cushion(Vec{a, 0}, Vec{w/2 - s, 0}, Vec{0, 1}, true, false)
	cushion(Vec{w/2 + s, 0}, Vec{w - a, 0}, Vec{0, 1}, false, true)
	cushion(Vec{a, h}, Vec{w/2 - s, h}, Vec{0, -1}, true, false)
	cushion(Vec{w/2 + s, h}, Vec{w - a, h}, Vec{0, -1}, false, true)
	cushion(Vec{0, a}, Vec{0, h - a}, Vec{1, 0}, true, true)
	cushion(Vec{w, a}, Vec{w, h - a}, Vec{-1, 0}, true, true)
}

// jaw returns the piece of cushion that runs from a nose into the pocket.
// along is the unit direction of the cushion away from the pocket; the jaw
// makes the configured angle with it, turning away from the playing surface.
// It is long enough to reach the drop line with a ball radius to spare.
func (t *Table) jaw(nose, along, inward Vec, corner bool) segment {
	angle, shelf := t.Cfg.SideJawAngle, t.Cfg.SideShelf
	if corner {
		angle, shelf = t.Cfg.CornerJawAngle, t.Cfg.CornerShelf
	}
	dir := along.Scale(math.Cos(angle)).Sub(inward.Scale(math.Sin(angle)))
	// Depth gained per unit length along the jaw is dir·axis; the pocket
	// axis is the bisector of the two jaws.
	var axis Vec
	for _, p := range t.pockets {
		if p.mouth.Dist(nose) <= p.half+1e-9 {
			axis = p.axis
			break
		}
	}
	gain := dir.Dot(axis)
	if gain < 0.1 {
		gain = 0.1
	}
	length := shelf/gain + t.Cfg.BallRadius
	return segment{nose, nose.Add(dir.Scale(length)), inward}
}

// Pockets returns, for drawing, the middle of each pocket mouth and the unit
// direction into the pocket, in pocket-index order.
func (t *Table) Pockets() (mouths, axes [NumPockets]Vec) {
	for i, p := range t.pockets {
		mouths[i], axes[i] = p.mouth, p.axis
	}
	return
}

// Rack puts all 16 balls back: cue ball on the head spot, the triangle with
// its apex on the foot spot. Events are cleared.
func (t *Table) Rack() {
	for i := range t.Balls {
		t.Balls[i] = Ball{ID: i}
	}
	t.Balls[CueBall].Pos = t.Cfg.HeadSpot()

	foot := t.Cfg.FootSpot()
	d := 2*t.Cfg.BallRadius + t.Cfg.RackGap
	rowDX := d * math.Sqrt(3) / 2
	n := 0
	for row := 0; row < 5; row++ {
		for j := 0; j <= row; j++ {
			id := rackOrder[n]
			n++
			t.Balls[id].Pos = Vec{
				X: foot.X + float64(row)*rowDX,
				Y: foot.Y + (float64(j)-float64(row)/2)*d,
			}
		}
	}
	t.ClearEvents()
}

// RackNine sets up a 9-ball break: balls 1–9 in a diamond, the cue ball on
// the head spot, and balls 10–15 off the table (pocketed, so the simulation
// ignores them).
func (t *Table) RackNine() {
	for i := range t.Balls {
		t.Balls[i] = Ball{ID: i, Pocketed: i > NineBall}
	}
	t.Balls[CueBall].Pos = t.Cfg.HeadSpot()

	foot := t.Cfg.FootSpot()
	d := 2*t.Cfg.BallRadius + t.Cfg.RackGap
	rowDX := d * math.Sqrt(3) / 2
	for row, ids := range nineRack {
		for j, id := range ids {
			t.Balls[id].Pos = Vec{
				X: foot.X + float64(row)*rowDX,
				Y: foot.Y + (float64(j)-float64(len(ids)-1)/2)*d,
			}
		}
	}
	t.ClearEvents()
}

// ClearEvents starts a new shot: it drops recorded events and re-arms
// first-contact and head-string detection.
func (t *Table) ClearEvents() {
	t.Events = t.Events[:0]
	t.Impacts = t.Impacts[:0]
	t.Clock = 0
	t.firstContact = false
	t.crossedHead = false
}

// Shoot strikes the cue ball dead centre: it starts sliding with no spin and
// rolls naturally once the cloth has taken 2⁄7 of its speed. angle is in
// radians (0 = +x, y down), power is clamped to [0,1] and scales MaxCueSpeed.
// It starts a new shot's event list.
func (t *Table) Shoot(angle, power float64) { t.ShootSpin(angle, power, Vec{}) }

// ShootSpin is Shoot with english: spin is the cue tip offset in units of
// Cfg.TipOffset·R (x right, y up as the shooter sees it), clamped to the unit
// disc. Top or bottom spin becomes Ball.Roll, side spin Ball.Side.
func (t *Table) ShootSpin(angle, power float64, spin Vec) { t.ShootElevated(angle, power, spin, 0) }

// MaxElevation is the steepest the cue can be raised, in radians above the
// horizontal: up to about 60° for a jump shot, steeper for a massé.
const MaxElevation = 85 * math.Pi / 180

// pinElevation is where the raised cue comes to stand over the cue ball.
// Steeper, its follow-through keeps the ball down on the slate: the bounce
// off the strike shrinks in proportion, to nothing at 90°.
const pinElevation = 60 * math.Pi / 180

// ShootElevated is ShootSpin with the butt of the cue raised elevation
// radians (clamped to [0, MaxElevation]): a jump shot or a massé. At 0 it
// is ShootSpin.
//
// The cue drives the ball along its axis, so the part of the speed that
// goes into the slate bounces the ball up off it (see land, and
// pinElevation past 60°) and only the rest carries it forward; the slate's
// friction during that bounce takes some of the forward speed and turns it
// into roll.
//
// The tip offset is taken square to the cue, so its spin tilts with it: top
// or bottom spin still turns the ball about the horizontal axis across the
// shot, but side spin turns it about the cue's own axis, which is upright
// for a raised cue. The upright part is english (Spin); the part along the
// shot rolls the ball sideways (Roll across Vel). The cloth's friction on
// that sideways slip curves the ball toward the side the tip struck, along
// a parabola, until it rolls: a massé. Left to the cloth rather than spent
// in the strike's bounce, the curve keeps the shape high-speed video shows
// (Alciatore) instead of a kink at the cue ball.
func (t *Table) ShootElevated(angle, power float64, spin Vec, elevation float64) {
	power = math.Max(0, math.Min(1, power))
	speed := power * t.Cfg.MaxCueSpeed
	if l := spin.Len(); l > 1 {
		spin = spin.Scale(1 / l)
	}
	elevation = math.Max(0, math.Min(MaxElevation, elevation))
	ahead, down := speed*math.Cos(elevation), speed*math.Sin(elevation)
	t.ClearEvents()
	cue := &t.Balls[CueBall]
	dir := Vec{math.Cos(angle), math.Sin(angle)}
	right := Vec{-dir.Y, dir.X} // as the shooter sees it
	k := 2.5 * t.Cfg.TipOffset
	cue.Vel = dir.Scale(ahead)
	cue.Roll = dir.Scale(k * spin.Y * speed)
	cue.Spin = -k * spin.X * ahead // tip right of centre: clockwise from above
	if down > 0 {
		t.land(cue, down)
		if elevation > pinElevation {
			if cue.VZ *= (math.Pi/2 - elevation) / (math.Pi/2 - pinElevation); cue.VZ < hopStop {
				cue.VZ = 0
			}
		}
	}
	cue.Roll = cue.Roll.Add(right.Scale(k * spin.X * down))
}

// Settled reports whether every ball on the table is at rest: neither
// moving nor spinning in place.
func (t *Table) Settled() bool {
	for i := range t.Balls {
		b := &t.Balls[i]
		if !b.Pocketed && (b.Vel != (Vec{}) || b.Roll != (Vec{}) || b.Airborne()) {
			return false
		}
	}
	return true
}

// Snapshot returns the positions of the balls still on the table, by id.
func (t *Table) Snapshot() []BallState {
	out := make([]BallState, 0, NumBalls)
	for i := range t.Balls {
		b := &t.Balls[i]
		if !b.Pocketed {
			out = append(out, BallState{ID: b.ID, X: b.Pos.X, Y: b.Pos.Y, Z: b.Z})
		}
	}
	return out
}

// Step advances the simulation by dt seconds and appends to Events. It sets
// Collided when a ball bounced off anything during this step.
func (t *Table) Step(dt float64) {
	t.Collided = false
	t.Clock += dt
	t.integrate(dt)
	t.capturePockets()
	t.collideCushions()
	t.collideBalls(dt)
}

// integrate applies cloth friction and moves the balls.
//
// A ball whose spin does not match its velocity slides: friction μg at the
// contact point opposes the slip, slowing the ball at μg and spinning it up
// at 5⁄2 μg (a solid sphere), so the slip closes at 7⁄2 μg and a ball struck
// dead centre keeps 5⁄7 of its speed once it rolls. A rolling ball loses
// speed to rolling resistance alone. Follow, draw and the way a ball dies
// after a cushion all come out of this.
//
// A ball in the air feels gravity alone and keeps its spin until it comes
// down on the slate, where it bounces (see land).
func (t *Table) integrate(dt float64) {
	cfg := &t.Cfg
	for i := range t.Balls {
		b := &t.Balls[i]
		if b.Pocketed {
			continue
		}
		if b.Airborne() {
			prevX := b.Pos.X
			b.Pos = b.Pos.Add(b.Vel.Scale(dt))
			b.Z += b.VZ*dt - gravity*dt*dt/2
			b.VZ -= gravity * dt
			if b.Z <= 0 {
				vn := -b.VZ
				t.impact(ImpactSlate, vn)
				t.land(b, vn)
				t.Collided = t.Collided || b.VZ > 0
			}
			t.crossHead(b, prevX)
			continue
		}
		if slip := b.Vel.Sub(b.Roll); slip != (Vec{}) {
			sl := slip.Len()
			d := math.Min(sl, 3.5*cfg.SlidingFriction*gravity*dt)
			u := slip.Scale(1 / sl)
			b.Vel = b.Vel.Sub(u.Scale(2.0 / 7 * d))
			if d == sl {
				b.Roll = b.Vel
			} else {
				b.Roll = b.Roll.Add(u.Scale(5.0 / 7 * d))
			}
		} else {
			speed := b.Vel.Len()
			if speed == 0 {
				continue
			}
			next := speed - cfg.RollingFriction*gravity*dt
			if next < cfg.StopSpeed {
				b.Vel, b.Roll, b.Spin = Vec{}, Vec{}, 0
				continue
			}
			b.Vel = b.Vel.Scale(next / speed)
			b.Roll = b.Vel
		}
		speed := b.Vel.Len()
		if speed == 0 {
			continue
		}
		prevX := b.Pos.X
		b.Pos = b.Pos.Add(b.Vel.Scale(dt))
		if b.Spin != 0 {
			// Cloth friction grinds side spin away; it lasts about twice
			// as long as follow or draw would.
			b.Spin *= math.Exp(-speed * dt / (2 * cfg.SpinDecayLength))
		}
		t.crossHead(b, prevX)
	}
}

// crossHead records the cue ball leaving the kitchen, if b, which was at x
// = prevX, is the cue ball and has just crossed the head string.
func (t *Table) crossHead(b *Ball, prevX float64) {
	if head := t.Cfg.HeadString(); b.ID == CueBall && !t.crossedHead && prevX <= head && b.Pos.X > head {
		t.crossedHead = true
		t.Events = append(t.Events, Event{Kind: HeadStringCrossed, Ball: CueBall})
	}
}

// hopStop is the slowest a ball bounces back up off the slate; a slower
// bounce (under half a millimetre high) leaves it on the cloth.
const hopStop = 0.1 // m/s

// land bounces b off the slate, which it hits at vn (m/s, > 0) from above:
// it goes back up with SlateRestitution of that, and the cloth's sliding
// friction, μ times the impulse, works on the slip between its speed and its
// roll as it would over a long slide (see integrate), so a ball comes down
// from a jump rolling more naturally each bounce.
func (t *Table) land(b *Ball, vn float64) {
	e := t.Cfg.SlateRestitution
	j := (1 + e) * vn
	if slip := b.Vel.Sub(b.Roll); slip != (Vec{}) {
		sl := slip.Len()
		d := math.Min(sl, 3.5*t.Cfg.SlidingFriction*j)
		u := slip.Scale(1 / sl)
		b.Vel = b.Vel.Sub(u.Scale(2.0 / 7 * d))
		if d == sl {
			b.Roll = b.Vel
		} else {
			b.Roll = b.Roll.Add(u.Scale(5.0 / 7 * d))
		}
	}
	b.Z, b.VZ = 0, e*vn
	if b.VZ < hopStop {
		b.VZ = 0
	}
}

// noseHeight is how high the cushion nose stands above the slate. A ball
// whose lowest point is above it flies over the cushions.
func (c *Config) noseHeight() float64 { return 2 * c.BallRadius * c.CushionNose }

// dropZone returns the index of the pocket whose drop zone holds pos, or -1.
func (t *Table) dropZone(pos Vec) int {
	for n, p := range t.pockets {
		rel := pos.Sub(p.mouth)
		depth := rel.Dot(p.axis)
		lateral := math.Abs(rel.X*p.axis.Y - rel.Y*p.axis.X)
		if depth >= p.shelf && lateral <= p.half+t.Cfg.BallRadius {
			return n
		}
	}
	return -1
}

// overBed reports whether a ball centred on pos is above the playing surface
// or a pocket opening, rather than above a cushion or off the table.
func (t *Table) overBed(pos Vec) bool {
	if pos.X >= 0 && pos.X <= t.Cfg.TableWidth && pos.Y >= 0 && pos.Y <= t.Cfg.TableHeight {
		return true
	}
	r := t.Cfg.BallRadius
	for _, p := range t.pockets {
		rel := pos.Sub(p.mouth)
		if rel.Dot(p.axis) > -r && math.Abs(rel.X*p.axis.Y-rel.Y*p.axis.X) <= p.half+r {
			return true
		}
	}
	return false
}

// pocketAt returns the index of the pocket whose drop zone holds pos, or -1.
// A ball on the cloth that somehow got clear of the rails is lost down the
// nearest pocket rather than left rolling forever.
func (t *Table) pocketAt(pos Vec) int {
	if n := t.dropZone(pos); n >= 0 {
		return n
	}
	m := 2 * t.Cfg.BallRadius
	if pos.X < -m || pos.Y < -m || pos.X > t.Cfg.TableWidth+m || pos.Y > t.Cfg.TableHeight+m {
		best, bestD := 0, math.Inf(1)
		for n, p := range t.pockets {
			if d := pos.Dist(p.mouth); d < bestD {
				best, bestD = n, d
			}
		}
		return best
	}
	return -1
}

// capturePockets drops the balls over a pocket and takes off the table the
// ones that flew over a cushion. A ball in the air falls into a pocket it is
// over once it is lower than a ball's height; one that has cleared a cushion
// is off the table as soon as it is lower than the cushion's nose, whether
// it came down on the rail or beyond it.
func (t *Table) capturePockets() {
	for i := range t.Balls {
		b := &t.Balls[i]
		if b.Pocketed {
			continue
		}
		if b.Airborne() {
			if n := t.dropZone(b.Pos); n >= 0 && b.Z < 2*t.Cfg.BallRadius {
				t.impact(ImpactPocket, b.Vel.Len())
				t.pocket(b, Event{Kind: BallPocketed, Ball: b.ID, Pocket: n})
			} else if !t.overBed(b.Pos) && b.Z < t.Cfg.noseHeight() {
				t.pocket(b, Event{Kind: BallOffTable, Ball: b.ID})
			}
			continue
		}
		if n := t.pocketAt(b.Pos); n >= 0 {
			t.impact(ImpactPocket, b.Vel.Len())
			t.pocket(b, Event{Kind: BallPocketed, Ball: b.ID, Pocket: n})
		}
	}
}

// pocket takes b out of play, as e records.
func (t *Table) pocket(b *Ball, e Event) {
	b.Pocketed = true
	b.Vel, b.Roll, b.Spin, b.Z, b.VZ = Vec{}, Vec{}, 0, 0, 0
	t.Events = append(t.Events, e)
}

// collideCushions bounces balls off the cushions and pocket jaws. A ball
// overlapping a segment is pushed out along the contact normal and, if it was
// moving into it, gets an impulse at the cushion nose (see bounce). Segment
// ends act as the rounded noses they are. A ball in the air higher than the
// nose passes over them.
func (t *Table) collideCushions() {
	r := t.Cfg.BallRadius
	nose := t.Cfg.noseHeight()
	for i := range t.Balls {
		b := &t.Balls[i]
		if b.Pocketed || b.Z >= nose {
			continue
		}
		hit := false
		for _, s := range t.segments {
			closest := s.closest(b.Pos)
			delta := b.Pos.Sub(closest)
			dist := delta.Len()
			if dist >= r {
				continue
			}
			n := s.inward
			if dist > 1e-12 {
				n = delta.Scale(1 / dist)
			}
			b.Pos = closest.Add(n.Scale(r))
			if vn := b.Vel.Dot(n); vn < 0 {
				t.impact(ImpactCushion, -vn)
				t.bounce(b, n)
				hit = true
				t.Collided = true
			}
		}
		if hit {
			t.Events = append(t.Events, Event{Kind: CushionHit, Ball: b.ID})
		}
	}
}

// cushionRestitution is the normal coefficient of restitution for a ball
// hitting a cushion at normal speed vn.
func (c *Config) cushionRestitution(vn float64) float64 {
	if vn <= c.CushionFastSpeed || c.MaxCueSpeed <= c.CushionFastSpeed {
		return c.CushionRestitution
	}
	f := math.Min(1, (vn-c.CushionFastSpeed)/(c.MaxCueSpeed-c.CushionFastSpeed))
	return c.CushionRestitution + f*(c.CushionRestitutionFast-c.CushionRestitution)
}

// bounce applies a cushion impact to b, whose velocity has a component
// against n, the unit normal from the cushion into the table. It is the
// impulse model of Han (2005) and pooltool, per unit mass and with the ball
// kept on the slate:
//
// The nose touches the ball at r = R(−cosθ·n + sinθ·ẑ), sinθ = 2·CushionNose
// − 1. The normal impulse J = (1+e)·vn reverses the normal speed (its torque
// about the raised contact is taken up by the slate, which the ball is
// pressed into, so it is left out). Friction at the nose, up to μJ, opposes
// the slip of the contact point: along the rail (t = ẑ × n) the slip is the
// tangential speed plus what side spin and roll add there, so english throws
// the ball along the rail and an oblique rebound loses speed; vertically the
// slip is the roll into the rail, so the rail scrubs that roll off. Where
// friction can stop the slip it does (stick), otherwise it slides at μJ.
func (t *Table) bounce(b *Ball, n Vec) {
	cfg := &t.Cfg
	vn := -b.Vel.Dot(n)
	e := cfg.cushionRestitution(vn)
	sin := 2*cfg.CushionNose - 1
	cos := math.Sqrt(1 - sin*sin)
	tan := Vec{-n.Y, n.X} // ẑ × n, along the rail

	// normal impulse
	j := (1 + e) * vn
	b.Vel = b.Vel.Add(n.Scale(j))
	rollN := b.Roll.Dot(n)
	rollT := b.Roll.Dot(tan)

	// friction: what it takes to stick along the rail and vertically
	slipT := b.Vel.Dot(tan) + sin*rollT - cos*b.Spin
	jt := -slipT / 3.5         // an impulse changes the contact speed 3.5× (1 + lever 2.5)
	jz := -rollN / (2.5 * cos) // vertical: only the roll into the rail slips there
	if f := math.Hypot(jt, jz); f > cfg.CushionFriction*j {
		k := cfg.CushionFriction * j / f
		jt, jz = jt*k, jz*k
	}
	b.Vel = b.Vel.Add(tan.Scale(jt))
	b.Spin -= 2.5 * cos * jt
	rollT += 2.5 * sin * jt
	rollN += 2.5 * cos * jz
	b.Roll = n.Scale(rollN).Add(tan.Scale(rollT))
}

// closest returns the point of the segment nearest to p.
func (s segment) closest(p Vec) Vec {
	ab := s.b.Sub(s.a)
	l2 := ab.Dot(ab)
	if l2 == 0 {
		return s.a
	}
	f := p.Sub(s.a).Dot(ab) / l2
	f = math.Max(0, math.Min(1, f))
	return s.a.Add(ab.Scale(f))
}

// impact records a contact of the given closing speed, if audible.
func (t *Table) impact(k ImpactKind, speed float64) {
	if speed >= minImpact {
		t.Impacts = append(t.Impacts, Impact{T: t.Clock, Kind: k, Speed: speed})
	}
}

// collideBalls resolves every overlapping pair. Two balls closing on each
// other are wound back to the instant they touched, exchange an equal-mass
// impulse along the line of centres there and move on with their new
// velocities for the rest of the step: the normal taken where they overlap
// at the end of the step would be off by up to 13° on a hard cut, so the
// object ball would not leave where the aim guide points. Balls that overlap
// without closing are pushed apart.
//
// Heights count: a ball in the air passes over one it is clear of, and one
// that comes down on another hits it on the line of centres in three
// dimensions, which drives the lower ball into the slate (it bounces off it,
// see integrate) and the upper one back up.
func (t *Table) collideBalls(dt float64) {
	minDist := 2 * t.Cfg.BallRadius
	e := t.Cfg.BallRestitution
	for i := 0; i < NumBalls; i++ {
		a := &t.Balls[i]
		if a.Pocketed {
			continue
		}
		for j := i + 1; j < NumBalls; j++ {
			b := &t.Balls[j]
			if b.Pocketed {
				continue
			}
			delta, dz := b.Pos.Sub(a.Pos), b.Z-a.Z
			dist := math.Hypot(delta.Len(), dz)
			if dist >= minDist {
				continue
			}
			rel, relZ := b.Vel.Sub(a.Vel), b.VZ-a.VZ
			back := contactTime(delta, dz, rel, relZ, minDist, dt)
			if back > 0 {
				a.Pos, a.Z = a.Pos.Sub(a.Vel.Scale(back)), a.Z-a.VZ*back
				b.Pos, b.Z = b.Pos.Sub(b.Vel.Scale(back)), b.Z-b.VZ*back
				delta, dz = b.Pos.Sub(a.Pos), b.Z-a.Z
				dist = math.Hypot(delta.Len(), dz)
			}
			// n, nz: the unit line of centres from a to b
			n, nz := Vec{1, 0}, 0.0
			if dist > 0 {
				n, nz = delta.Scale(1/dist), dz/dist
			}
			if dist < minDist {
				push := (minDist - dist) / 2
				a.Pos, a.Z = a.Pos.Sub(n.Scale(push)), math.Max(0, a.Z-nz*push)
				b.Pos, b.Z = b.Pos.Add(n.Scale(push)), math.Max(0, b.Z+nz*push)
			}

			vn := rel.Dot(n) + relZ*nz
			if vn < 0 {
				t.impact(ImpactBall, -vn)
				j := -(1 + e) / 2 * vn
				a.Vel, a.VZ = a.Vel.Sub(n.Scale(j)), a.VZ-nz*j
				b.Vel, b.VZ = b.Vel.Add(n.Scale(j)), b.VZ+nz*j
				t.Collided = true
			}
			// the rest of the step, with the new velocities
			a.Pos, a.Z = a.Pos.Add(a.Vel.Scale(back)), math.Max(0, a.Z+a.VZ*back)
			b.Pos, b.Z = b.Pos.Add(b.Vel.Scale(back)), math.Max(0, b.Z+b.VZ*back)
			if vn >= 0 {
				continue // already separating
			}
			// Spin is untouched by the collision (ball–ball friction is
			// negligible): a cue ball with follow or draw leaves the contact
			// nearly stopped but still spinning, and the cloth then carries
			// it forward or back. Each ball slides again until its spin
			// matches its new velocity.

			// i < j, so the cue ball can only be a.
			if i == CueBall && !t.firstContact {
				t.firstContact = true
				t.Events = append(t.Events, Event{
					Kind:      FirstContact,
					Ball:      b.ID,
					InKitchen: b.Pos.X < t.Cfg.HeadString(),
				})
			}
		}
	}
}

// contactTime returns how long ago two balls at separation delta (b − a)
// and dz in height, closing at relative velocity rel and relZ (b − a), were
// minDist apart, at most dt; 0 when they are not closing.
func contactTime(delta Vec, dz float64, rel Vec, relZ, minDist, dt float64) float64 {
	dr := delta.Dot(rel) + dz*relZ
	rr := rel.Dot(rel) + relZ*relZ
	if dr >= 0 || rr == 0 {
		return 0
	}
	// |delta − rel·τ| = minDist, the root with τ > 0
	c := delta.Dot(delta) + dz*dz - minDist*minDist
	tau := (dr + math.Sqrt(dr*dr-rr*c)) / rr
	return math.Max(0, math.Min(tau, dt))
}

// canPlace reports whether ball id could rest at pos: on the playing surface
// (inside the cushion-nose rectangle, not in a pocket mouth), clear of every
// cushion and not overlapping another ball.
func (t *Table) canPlace(id int, pos Vec) bool {
	r := t.Cfg.BallRadius
	if !(pos.X >= r && pos.X <= t.Cfg.TableWidth-r && pos.Y >= r && pos.Y <= t.Cfg.TableHeight-r) {
		return false // also rejects NaN
	}
	for _, p := range t.pockets {
		if pos.Sub(p.mouth).Dot(p.axis) > -r {
			return false // in, or hanging over, a pocket mouth
		}
	}
	for _, s := range t.segments {
		if pos.Dist(s.closest(pos)) < r {
			return false
		}
	}
	for i := range t.Balls {
		b := &t.Balls[i]
		if b.ID != id && !b.Pocketed && b.Pos.Dist(pos) < 2*r {
			return false
		}
	}
	return true
}

// PlaceCue moves the cue ball to pos (ball-in-hand), putting it back in play
// if it was pocketed. It reports false and changes nothing if pos is illegal.
func (t *Table) PlaceCue(pos Vec) bool { return t.PlaceBall(CueBall, pos) }

// PlaceBall puts ball id at rest on pos, back in play if it was pocketed. It
// reports false and changes nothing if pos is off the table, over a pocket,
// on a cushion or on another ball.
func (t *Table) PlaceBall(id int, pos Vec) bool {
	if id < 0 || id >= NumBalls || !t.canPlace(id, pos) {
		return false
	}
	t.Balls[id] = Ball{ID: id, Pos: pos}
	return true
}

// Spot puts ball id back in play at rest on want. If that point is occupied
// the ball goes on the nearest free point of the long axis through want,
// searching first in direction dir (+1 toward the foot rail, -1 toward the
// head rail) and only then the other way.
func (t *Table) Spot(id int, want Vec, dir float64) {
	step := t.Cfg.BallRadius / 8
	pos := want
search:
	for _, d := range [2]float64{dir, -dir} {
		for off := 0.0; off <= t.Cfg.TableWidth; off += step {
			if p := (Vec{want.X + d*off, want.Y}); t.canPlace(id, p) {
				pos = p
				break search
			}
		}
	}
	t.Balls[id] = Ball{ID: id, Pos: pos}
}
