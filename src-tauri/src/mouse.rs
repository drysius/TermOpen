use std::cmp::max;

pub const POINTER_INTERPOLATION_MAX_STEP: u16 = 24;
pub const WHEEL_DELTA_UNIT: i32 = 120;

#[derive(Debug, Default, Clone, Copy)]
pub struct WheelAccumulator {
    horizontal_remainder: i32,
    vertical_remainder: i32,
}

impl WheelAccumulator {
    pub fn push(&mut self, delta_x: i16, delta_y: i16) -> (Vec<i16>, Vec<i16>) {
        self.horizontal_remainder = self.horizontal_remainder.saturating_add(i32::from(delta_x));
        self.vertical_remainder = self.vertical_remainder.saturating_add(i32::from(delta_y));

        let horizontal = drain_wheel_steps(&mut self.horizontal_remainder);
        let vertical = drain_wheel_steps(&mut self.vertical_remainder);
        (horizontal, vertical)
    }
}

pub fn interpolate_pointer_route(
    from_x: u16,
    from_y: u16,
    to_x: u16,
    to_y: u16,
) -> Vec<(u16, u16)> {
    let dx = i32::from(to_x) - i32::from(from_x);
    let dy = i32::from(to_y) - i32::from(from_y);
    let max_axis = max(dx.abs(), dy.abs()) as u16;
    if max_axis <= POINTER_INTERPOLATION_MAX_STEP {
        return vec![(to_x, to_y)];
    }

    let steps = usize::from((max_axis / POINTER_INTERPOLATION_MAX_STEP).max(1));
    let mut points = Vec::with_capacity(steps + 1);
    for step in 1..=steps {
        let ratio = step as f64 / steps as f64;
        let x = (f64::from(from_x) + f64::from(dx) * ratio).round() as i32;
        let y = (f64::from(from_y) + f64::from(dy) * ratio).round() as i32;
        points.push((
            x.clamp(0, i32::from(u16::MAX)) as u16,
            y.clamp(0, i32::from(u16::MAX)) as u16,
        ));
    }
    if points.last().copied() != Some((to_x, to_y)) {
        points.push((to_x, to_y));
    }
    points
}

fn drain_wheel_steps(remainder: &mut i32) -> Vec<i16> {
    let mut steps = Vec::new();
    while remainder.unsigned_abs() >= WHEEL_DELTA_UNIT as u32 {
        let unit = if *remainder >= 0 {
            WHEEL_DELTA_UNIT
        } else {
            -WHEEL_DELTA_UNIT
        };
        *remainder -= unit;
        steps.push(unit as i16);
    }

    // Preserve responsiveness for touchpads that report small deltas.
    if steps.is_empty() && remainder.unsigned_abs() >= 30 {
        let unit = if *remainder >= 0 {
            WHEEL_DELTA_UNIT
        } else {
            -WHEEL_DELTA_UNIT
        };
        *remainder = 0;
        steps.push(unit as i16);
    }

    steps
}

#[cfg(test)]
mod tests {
    use super::{interpolate_pointer_route, WheelAccumulator, WHEEL_DELTA_UNIT};

    #[test]
    fn should_keep_route_monotonic() {
        let points = interpolate_pointer_route(0, 0, 400, 0);
        assert!(points.len() > 2);
        assert_eq!(points.last().copied(), Some((400, 0)));
        assert!(points.windows(2).all(|pair| pair[1].0 >= pair[0].0));
    }

    #[test]
    fn should_emit_wheel_notches_with_accumulation() {
        let mut accumulator = WheelAccumulator::default();
        let (x1, y1) = accumulator.push(0, 40);
        assert!(x1.is_empty());
        assert_eq!(y1.len(), 1);
        assert_eq!(i32::from(y1[0]), WHEEL_DELTA_UNIT);

        let (_, y2) = accumulator.push(0, 120);
        assert_eq!(y2.len(), 1);
        assert_eq!(i32::from(y2[0]), WHEEL_DELTA_UNIT);
    }
}
