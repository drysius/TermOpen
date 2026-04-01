#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamViewport {
    pub width: u16,
    pub height: u16,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamControlInput {
    #[serde(default)]
    pub viewport: Option<StreamViewport>,
    #[serde(default)]
    pub active: Option<bool>,
    #[serde(default)]
    pub pointer_inside: Option<bool>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamControlState {
    pub viewport: StreamViewport,
    pub active: bool,
    pub pointer_inside: bool,
}

impl StreamControlState {
    pub fn new(viewport: StreamViewport) -> Self {
        Self {
            viewport,
            active: true,
            pointer_inside: true,
        }
    }

    pub fn apply(&mut self, update: StreamControlInput) {
        if let Some(viewport) = update.viewport {
            self.viewport = viewport;
        }
        if let Some(active) = update.active {
            self.active = active;
        }
        if let Some(pointer_inside) = update.pointer_inside {
            self.pointer_inside = pointer_inside;
        }
    }
}
