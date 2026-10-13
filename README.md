# Firing Order: engine sound prototype

Generated engine sound for an EV. No recordings: each cylinder firing is generated at its
crank angle, then shaped by its exhaust runner, the pipes and the muffler.

Engines: Porsche 911 GT3 (flat-six), Nissan GT-R (twin-turbo V6), Audi S3 (turbo four),
Ferrari 458 Italia (flat-plane V8). The names describe the simulated sound; there is no
affiliation with the manufacturers.

## The simulated engine

`engine-physics.js` simulates the engine rather than shaping a sound:

- **Cylinders:** gas mass and temperature in every cylinder, crank-angle by crank-angle. Piston motion from bore, stroke and rod; valve flow from cam timing, lift and valve sizes; combustion as a Wiebe burn after the spark.
- **Intake:** a plenum fed through the throttle. A controller holds the manifold pressure the pedal asks for, so cruise really runs in vacuum, and boost comes from the turbo model.
- **Exhaust:** every header, collector, turbine, silencer and tailpipe is a pipe of travelling pressure waves (digital waveguides) joined at junctions. The flow out of each exhaust valve is solved together with the pressure it raises in its pipe.
- **Sound:** what radiates from the tailpipes and the intake mouth, plus the block shaking under cylinder pressure, then the cabin model.

Checked against real engines: about 0.3-0.45 bar manifold pressure at light cruise and 0.97 bar at full throttle (1.6-1.9 bar on boost); peak cylinder pressure 90-125 bar at full load and 4-6 bar on the overrun; cylinder filling of about 90% at full throttle. Every car is built angry: big-overlap cams, short headers, straight-through silencers, valves always open.

It runs at about 6-11x real time. A quick speed check when you start the engine falls back to the Classic sound if the screen's computer is too slow. Settings → Engine sound switches between the two.

**Engine view** (the button next to settings) opens on a **3D engine** built from each car's real geometry (flat-six, 60° V6, 90° V8, inline four): crankshaft, pistons and rods on true kinematics, camshafts at half speed, valves, combustion glowing through a see-through block, headers glowing with exhaust heat and flashing with each pulse, turbos spinning with boost. Drag to turn, pinch or scroll to zoom. Three.js (r128) is loaded from cdnjs when the view opens and cached for offline use. The **Diagram** tab shows the same engine as a schematic: pistons, rods and cranks, valves opening, the gas heating and burning, each cylinder's pressure, a full-cycle pressure trace for the cylinder you tap, and the pressure waves travelling through the exhaust. It runs the same simulation as the sound, with the same revs, throttle, boost and lift-off, slowed down so one engine cycle takes 2 s (or 7 s).

## Run it

```
python3 -m http.server 5178
```

Then open http://localhost:5178 and press **Start engine** (or Space).

- **Simulated drive:** hold ↑ / W for throttle (Shift for 40%), ↓ / S to brake, or use the on-screen pedals.
- **Feel it like the car will:** runs the simulator through the 9 Hz, noisy GPS path and works out throttle from acceleration, as the car has to.
- **Real GPS:** needs HTTPS on a phone or in the car. Location only works on https:// or localhost.
- **Manual:** E / Q, the scroll wheel, or the Tesla scroll button shifts.

- **Listen from:** driver's seat (body boom, damped highs, cabin reflections) or outside.
- **Reference recording:** load a recording of the real car; its spectrum shows in blue so you can match peaks.

`renders/` has 13-second offline renders of each engine, from the cabin and from outside
(idle, blip, full pull, overrun with crackles).

## How it reads the Tesla

The browser can't see the pedal, so everything comes from GPS speed:

- A Kalman filter estimates speed and acceleration at whatever rate the car delivers fixes.
- Throttle is worked out from acceleration plus road load. It is held steady at cruise and reacts in a few tenths of a second when you put your foot down.
- Lifting off (regen) becomes a closed-throttle overrun, judged on a slower reading so GPS noise can't flick it on and off. Below 7 km/h the clutch is open and the engine idles.
- Chill mode is scaled, so flooring it in Chill still sounds like full throttle.
- GPS dropouts (tunnels) hold speed until the signal returns.

**Drive modes:** Comfort upshifts early and cruises at 1,300-2,200 rpm with the exhaust valves shut. Sport holds gears, keeps the valves open and lets it pop.

**Test drive:** a scripted 90-second drive (town, lights, motorway on cruise control, overtake, slip road, roundabout) run through the same GPS path as the car.

**Car check (settings):** run it once in the car. It reports the GPS rate, whether fixes carry speed, motion sensors, what the steering-wheel scroll button sends, and audio output.

## Files

- `engine-physics.js`: the simulated engine (cylinders, valves, combustion, exhaust waves)
- `engine-view.js`: the engine view
- `engine-worklet.js`: the audio worklet: runs the simulated engine (or the classic synthesis), turbo, gearbox, pops and the cabin model
- `engines.js`: per-engine firing order, exhaust layout, gear ratios, tuning values
- `drive-model.js`: Tesla model, GPS Kalman filter, load inference, test drive
- `app.js`: gearbox, ignition, UI, car check

## Matching real recordings

`tools/match.js` compares the synthesis with real recordings and tunes it. It tracks the revs from
the recording itself, measures each engine harmonic relative to the firing note per rpm range (order
tracking) plus the tonal balance, ignores anything buried in the recording's noise, then adjusts the
sound settings until the synthesis has the same fingerprint.

```
node tools/match.js gt3          # report the mismatch
node tools/match.js gt3 --fit    # tune, writes tools/fitted-gt3.json
```

The recordings are used only for measurement; none is shipped with the app. They go in `reference/`
(not committed):

- "Porsche 997 GT3 RS.ogg" by Edvvc, CC BY-SA 3.0, Wikimedia Commons
- "Ferrari 458 Italia.ogg" by Edvvc, CC BY-SA 3.0, Wikimedia Commons
- "Nissan GT-R SpecV.ogg" by Edvvc, CC BY-SA 3.0, Wikimedia Commons
- "2006 Porsche Cayman S engine sound.wav" by John64, CC BY-SA 3.0, Wikimedia Commons

No free recording of an Audi S3 (2.0 TFSI) could be found, so the S3 is not fitted.
