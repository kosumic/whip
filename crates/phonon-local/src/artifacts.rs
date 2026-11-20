pub const REVISION: &str = "8c64b55ec301728e2d1695bfea87a08a267d0c2d";
pub const SAMPLE_RATE: u32 = 24_000;
pub const DEFAULT_VOICE: &str = "default";

#[derive(Clone, Copy)]
pub struct Artifact {
    pub name: &'static str,
    pub bytes: u64,
    pub sha256: &'static str,
}

#[cfg(not(target_os = "ios"))]
pub const ARTIFACTS: &[Artifact] = &[
    Artifact {
        name: "config.json",
        bytes: 2_851,
        sha256: "7062ea376e6b158543c8abec8e5af67df171c49ad70eb7e2a0fb25c16f265e06",
    },
    Artifact {
        name: "tokenizer.json",
        bytes: 277_967,
        sha256: "691a00068fa7b989f2f3e5ae5daa2d1a5bb319f2d5360deafcfb19a8bb6e7936",
    },
    Artifact {
        name: "default-voice.safetensors",
        bytes: 256_136,
        sha256: "f739e8c4c76ee7f92e7c94a82002748c8cd22e99582ac49f7b9b94cd63786e18",
    },
    Artifact {
        name: "model.q8.gguf",
        bytes: 64_512_352,
        sha256: "a7d9aad2cd6dc66473f24a08bc6d2939030ef4d751ef82349361fbef3272dbae",
    },
];

#[cfg(target_os = "ios")]
pub const ARTIFACTS: &[Artifact] = &[COREML_ARTIFACT];

/// Pinned archive, also available for model-free bundle verification tests.
pub const COREML_ARTIFACT: Artifact = Artifact {
    name: "phonon-31m-en-coreml.zip",
    bytes: 137_300_815,
    sha256: "2869326ab074f55ed5b644e68b1befef69dc51545b73296d49f5b4dab14c4218",
};
