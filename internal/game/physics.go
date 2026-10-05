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

type pocket struct {
	pos    Vec
	radius float64
}

// Table is the physics world: the balls and the events of the current shot.
// It is not safe for concurrent use; the owning room goroutine drives it.
type Table struct {
	Cfg   Config
	Balls [NumBalls]Ball // indexed by ball id
	// Events accumulates what happened since the last Shoot (or ClearEvents).
	Events []Event

	pockets      [6]pocket
	firstContact bool // the cue ball has already touched an object ball this shot
}

// NewTable returns a racked table ready for the break.
func NewTable(cfg Config) *Table {
	t := &Table{Cfg: cfg}
	w, h := cfg.TableWidth, cfg.TableHeight
	t.pockets = [6]pocket{
		{Vec{0, 0}, cfg.CornerCaptureRadius},
		{Vec{w / 2, 0}, cfg.SideCaptureRadius},
		{Vec{w, 0}, cfg.CornerCaptureRadius},
		{Vec{0, h}, cfg.CornerCaptureRadius},
		{Vec{w / 2, h}, cfg.SideCaptureRadius},
		{Vec{w, h}, cfg.CornerCaptureRadius},
	}
	t.Rack()
	return t
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

// ClearEvents starts a new shot: it drops recorded events and re-arms
// first-contact detection.
func (t *Table) ClearEvents() {
	t.Events = t.Events[:0]
	t.firstContact = false
}

// Shoot strikes the cue ball. angle is in radians (0 = +x, y down), power is
// clamped to [0,1] and scales MaxCueSpeed. It starts a new shot's event list.
func (t *Table) Shoot(angle, power float64) {
	power = math.Max(0, math.Min(1, power))
	speed := power * t.Cfg.MaxCueSpeed
	t.ClearEvents()
	t.Balls[CueBall].Vel = Vec{math.Cos(angle) * speed, math.Sin(angle) * speed}
}

// Settled reports whether every ball on the table has zero speed.
func (t *Table) Settled() bool {
	for i := range t.Balls {
		b := &t.Balls[i]
		if !b.Pocketed && (b.Vel.X != 0 || b.Vel.Y != 0) {
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
			out = append(out, BallState{ID: b.ID, X: b.Pos.X, Y: b.Pos.Y})
		}
	}
	return out
}

// Step advances the simulation by dt seconds and appends to Events.
func (t *Table) Step(dt float64) {
	t.integrate(dt)
	t.capturePockets()
	t.collideCushions()
	t.collideBalls()
}

// integrate applies rolling friction and moves the balls.
func (t *Table) integrate(dt float64) {
	for i := range t.Balls {
		b := &t.Balls[i]
		if b.Pocketed {
			continue
		}
		speed := b.Vel.Len()
		if speed == 0 {
			continue
		}
		next := speed - t.Cfg.RollingDecel*dt
		if next < t.Cfg.StopSpeed {
			b.Vel = Vec{}
			continue
		}
		b.Vel = b.Vel.Scale(next / speed)
		b.Pos = b.Pos.Add(b.Vel.Scale(dt))
	}
}

func (t *Table) capturePockets() {
	for i := range t.Balls {
		b := &t.Balls[i]
		if b.Pocketed {
			continue
		}
		for _, p := range t.pockets {
			if b.Pos.Dist(p.pos) <= p.radius {
				b.Pocketed = true
				b.Vel = Vec{}
				t.Events = append(t.Events, Event{BallPocketed, b.ID})
				break
			}
		}
	}
}

// collideCushions keeps ball centers inside the rails (the table edges inset
// by the ball radius), reflecting the normal velocity component.
func (t *Table) collideCushions() {
	r, e := t.Cfg.BallRadius, t.Cfg.CushionRestitution
	maxX, maxY := t.Cfg.TableWidth-r, t.Cfg.TableHeight-r
	for i := range t.Balls {
		b := &t.Balls[i]
		if b.Pocketed {
			continue
		}
		hit := false
		if b.Pos.X < r {
			b.Pos.X = r
			if b.Vel.X < 0 {
				b.Vel.X *= -e
				hit = true
			}
		} else if b.Pos.X > maxX {
			b.Pos.X = maxX
			if b.Vel.X > 0 {
				b.Vel.X *= -e
				hit = true
			}
		}
		if b.Pos.Y < r {
			b.Pos.Y = r
			if b.Vel.Y < 0 {
				b.Vel.Y *= -e
				hit = true
			}
		} else if b.Pos.Y > maxY {
			b.Pos.Y = maxY
			if b.Vel.Y > 0 {
				b.Vel.Y *= -e
				hit = true
			}
		}
		if hit {
			t.Events = append(t.Events, Event{CushionHit, b.ID})
		}
	}
}

// collideBalls resolves every overlapping pair: the balls are pushed apart
// along the contact normal and, if approaching, exchange an equal-mass impulse.
func (t *Table) collideBalls() {
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
			delta := b.Pos.Sub(a.Pos)
			dist := delta.Len()
			if dist >= minDist {
				continue
			}
			n := Vec{1, 0}
			if dist > 0 {
				n = delta.Scale(1 / dist)
			}
			push := n.Scale((minDist - dist) / 2)
			a.Pos = a.Pos.Sub(push)
			b.Pos = b.Pos.Add(push)

			vn := b.Vel.Sub(a.Vel).Dot(n)
			if vn >= 0 {
				continue // already separating
			}
			impulse := n.Scale(-(1 + e) / 2 * vn)
			a.Vel = a.Vel.Sub(impulse)
			b.Vel = b.Vel.Add(impulse)

			// i < j, so the cue ball can only be a.
			if i == CueBall && !t.firstContact {
				t.firstContact = true
				t.Events = append(t.Events, Event{FirstContact, b.ID})
			}
		}
	}
}
