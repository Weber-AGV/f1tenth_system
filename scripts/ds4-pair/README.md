# ds4-pair: fix an off-brand PS4 controller that won't reconnect

**This is an edge case.** A normal Sony DS4 never needs this script. It exists
for off-brand (clone) PS4 controllers, one of which cost us a lot of time on
robot 2.

## Try this first (any controller)

If a controller only blinks on PS and won't connect, pair it again on the car:

```bash
bluetoothctl remove <controller MAC>     # if the car lists it
```

then hold Share + PS until the light double-blinks and pair it (`bluetoothctl`:
`scan on`, `pair <MAC>`, `trust <MAC>`). A real DS4 takes the car as its new
home on that pairing and connects from then on.

## Use this script when

the car says "Pairing successful", the controller hangs up about 5 seconds
later, and pressing PS afterwards still only blinks. That is an off-brand
controller that pairs but keeps calling some other computer.

## Fix

Plug the controller into the car's USB with a cable, then on the car:

```bash
sudo python3 ~/f1tenth_ws/src/f1tenth_system/scripts/ds4-pair/ds4_pair.py
```

Unplug it and press PS. The light should go solid. If the car has no key for
this controller yet, the script asks you to hold Share + PS once while it
pairs, then to plug the controller back in. Just follow its prompts.

Only want to look? `--check` prints which computer the controller calls and
changes nothing:

```text
pad A0:5A:5D:88:F7:EC calls F8:63:3F:99:49:53; this car is 1C:CE:51:F6:D1:80
```

## Why it happens

A DS4 remembers **one** computer and only ever calls that one. Two things
change it:

- **Share + PS pairing.** A real DS4 saves the computer it pairs with. Some
  off-brand ones don't: they pair, then go on calling the old computer.
- **Plugging it into a laptop over USB.** On a laptop with the Sony driver,
  the laptop's Bluetooth service quietly writes the laptop into the
  controller. Nothing asks you first.

So an off-brand controller that was once plugged into a laptop is stuck calling
that laptop, and re-pairing on the car can't undo it. The car can't do the
laptop's USB trick either: the Jetson kernel has no Sony controller driver,
and BlueZ only does it for controllers on that driver. This script does that
step by hand: it writes the car's Bluetooth address and the car's saved key for
the controller into the controller.

Tell-tale sign of the off-brand pad on robot 2: it reports a DS4 v2
(`054c:09cc`) over USB but a DS4 v1 (`054c:05c4`) over Bluetooth.

**Avoid it:** don't plug a car's controller into your laptop. Charge it on the
car's USB (a plain wall charger may not charge a DS4 at all).

## What it changes

- In the controller: which computer it calls, and the key it uses.
- On the car: nothing, unless the car had no key for the controller. Then it
  pairs it over Bluetooth once and marks it trusted, the same as
  `bluetoothctl pair` and `trust`.

Controller and car Bluetooth addresses never change, and the script reads both
itself, so the same command works on every car. `--self-test` checks its
parsing without a controller or sudo.
