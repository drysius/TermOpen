#![allow(dead_code)]

use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use anyhow::{anyhow, Context, Result};

use crate::libs::transfer::{
    transfer_reader_to_writer, TransferJobConfig, DEFAULT_MAX_CHUNK_SIZE, DEFAULT_MIN_CHUNK_SIZE,
};

const TRANSFER_CACHE_DIR: &str = "openptl-transfer-cache";
const STAGING_SPOOL_FILE: &str = "spool.bin";
const STAGING_MANIFEST_FILE: &str = "manifest.json";
const STAGING_CHUNKS_DIR: &str = "chunks";

fn sanitize_task_id_for_fs(task_id: &str) -> String {
    let mut out = String::with_capacity(task_id.len());
    for ch in task_id.trim().chars() {
        let safe = ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.');
        if safe {
            out.push(ch);
        } else {
            out.push('_');
        }
    }

    let compact = out.trim_matches('_');
    if compact.is_empty() {
        "transfer".to_string()
    } else {
        compact.to_string()
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFsChunkMetadata {
    pub index: u64,
    pub offset: u64,
    pub size: u64,
    pub file_name: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFsManifest {
    pub task_id: String,
    pub total_bytes: u64,
    pub created_at_unix_ms: i64,
    pub chunks: Vec<RemoteFsChunkMetadata>,
}

#[derive(Debug, Clone)]
pub struct RemoteFsStagingArea {
    pub task_id: String,
    pub root_dir: PathBuf,
    pub spool_file: PathBuf,
    pub chunks_dir: PathBuf,
    pub manifest_file: PathBuf,
}

pub fn normalize_chunk_size(chunk_size: usize) -> usize {
    chunk_size
        .max(DEFAULT_MIN_CHUNK_SIZE)
        .min(DEFAULT_MAX_CHUNK_SIZE)
}

pub fn transfer_cache_root() -> PathBuf {
    std::env::temp_dir().join(TRANSFER_CACHE_DIR)
}

pub fn prepare_staging_area(task_id: &str) -> Result<RemoteFsStagingArea> {
    let normalized_task_id = sanitize_task_id_for_fs(task_id);
    if normalized_task_id.is_empty() {
        return Err(anyhow!("Task id invalido para staging remoto."));
    }

    let root_dir = transfer_cache_root().join(normalized_task_id.as_str());
    let chunks_dir = root_dir.join(STAGING_CHUNKS_DIR);
    fs::create_dir_all(&chunks_dir).with_context(|| {
        format!(
            "Falha ao criar staging de transferencia {}",
            root_dir.display()
        )
    })?;

    Ok(RemoteFsStagingArea {
        task_id: normalized_task_id,
        spool_file: root_dir.join(STAGING_SPOOL_FILE),
        manifest_file: root_dir.join(STAGING_MANIFEST_FILE),
        root_dir,
        chunks_dir,
    })
}

pub fn open_spool_writer(area: &RemoteFsStagingArea) -> Result<File> {
    if let Some(parent) = area.spool_file.parent() {
        fs::create_dir_all(parent)?;
    }
    File::create(&area.spool_file).with_context(|| {
        format!(
            "Falha ao abrir spool para escrita {}",
            area.spool_file.display()
        )
    })
}

pub fn open_spool_reader(area: &RemoteFsStagingArea) -> Result<File> {
    File::open(&area.spool_file).with_context(|| {
        format!(
            "Falha ao abrir spool para leitura {}",
            area.spool_file.display()
        )
    })
}

pub fn spool_file_size(area: &RemoteFsStagingArea) -> Result<u64> {
    let metadata = fs::metadata(&area.spool_file).with_context(|| {
        format!(
            "Falha ao obter metadados do spool de transferencia {}",
            area.spool_file.display()
        )
    })?;
    Ok(metadata.len())
}

pub fn write_spool_from_reader<R: Read>(
    area: &RemoteFsStagingArea,
    reader: &mut R,
    config: TransferJobConfig,
) -> Result<u64> {
    let mut writer = open_spool_writer(area)?;
    let metrics =
        transfer_reader_to_writer(reader, &mut writer, config, |_bytes, _chunk, _rtt| {})?;
    Ok(metrics.total_bytes)
}

pub fn read_spool_to_writer<W: Write, F: FnMut(u64)>(
    area: &RemoteFsStagingArea,
    writer: &mut W,
    chunk_size: usize,
    mut on_chunk: F,
) -> Result<u64> {
    let mut reader = open_spool_reader(area)?;
    let mut transferred = 0u64;
    let mut buffer = vec![0u8; normalize_chunk_size(chunk_size)];

    loop {
        let read_size = reader
            .read(&mut buffer)
            .with_context(|| format!("Falha ao ler spool {}", area.spool_file.display()))?;
        if read_size == 0 {
            break;
        }
        writer
            .write_all(&buffer[..read_size])
            .with_context(|| "Falha ao escrever spool em destino final".to_string())?;
        transferred = transferred.saturating_add(read_size as u64);
        on_chunk(transferred);
    }

    Ok(transferred)
}

pub fn fragment_spool(area: &RemoteFsStagingArea, chunk_size: usize) -> Result<RemoteFsManifest> {
    let mut reader = open_spool_reader(area)?;
    reader.seek(SeekFrom::Start(0)).with_context(|| {
        format!(
            "Falha ao reposicionar spool para fragmentacao {}",
            area.spool_file.display()
        )
    })?;

    fs::create_dir_all(&area.chunks_dir).with_context(|| {
        format!(
            "Falha ao preparar pasta de fragmentos {}",
            area.chunks_dir.display()
        )
    })?;

    for entry in fs::read_dir(&area.chunks_dir)? {
        let entry = entry?;
        if entry.path().is_file() {
            let _ = fs::remove_file(entry.path());
        }
    }

    let mut chunks = Vec::new();
    let mut offset = 0u64;
    let normalized = normalize_chunk_size(chunk_size);
    let mut buffer = vec![0u8; normalized];
    let mut index = 0u64;

    loop {
        let read_size = reader.read(&mut buffer).with_context(|| {
            format!(
                "Falha ao ler spool para fragmentacao {}",
                area.spool_file.display()
            )
        })?;
        if read_size == 0 {
            break;
        }

        let file_name = format!("{:06}.part", index);
        let chunk_path = area.chunks_dir.join(file_name.as_str());
        let mut chunk_file = File::create(&chunk_path).with_context(|| {
            format!(
                "Falha ao criar fragmento de transferencia {}",
                chunk_path.display()
            )
        })?;
        chunk_file
            .write_all(&buffer[..read_size])
            .with_context(|| format!("Falha ao gravar fragmento {}", chunk_path.display()))?;

        chunks.push(RemoteFsChunkMetadata {
            index,
            offset,
            size: read_size as u64,
            file_name,
        });

        offset = offset.saturating_add(read_size as u64);
        index = index.saturating_add(1);
    }

    let created_at = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or(Duration::from_secs(0))
        .as_millis() as i64;

    let manifest = RemoteFsManifest {
        task_id: area.task_id.clone(),
        total_bytes: offset,
        created_at_unix_ms: created_at,
        chunks,
    };

    let json = serde_json::to_vec_pretty(&manifest)
        .context("Falha ao serializar manifesto de transferencia.")?;
    fs::write(&area.manifest_file, json).with_context(|| {
        format!(
            "Falha ao salvar manifesto de transferencia {}",
            area.manifest_file.display()
        )
    })?;

    Ok(manifest)
}

pub fn load_manifest(area: &RemoteFsStagingArea) -> Result<RemoteFsManifest> {
    let bytes = fs::read(&area.manifest_file).with_context(|| {
        format!(
            "Falha ao ler manifesto de transferencia {}",
            area.manifest_file.display()
        )
    })?;
    serde_json::from_slice(&bytes).context("Falha ao desserializar manifesto de transferencia.")
}

pub fn finalize_spool_atomic(area: &RemoteFsStagingArea, target: &Path) -> Result<()> {
    let parent = target
        .parent()
        .ok_or_else(|| anyhow!("Destino final invalido para finalize_spool_atomic"))?;
    fs::create_dir_all(parent)
        .with_context(|| format!("Falha ao criar pasta destino {}", parent.display()))?;

    let temp_target = parent.join(format!(
        ".{}.partial",
        target
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| "output".to_string())
    ));
    fs::copy(&area.spool_file, &temp_target).with_context(|| {
        format!(
            "Falha ao copiar spool {} para {}",
            area.spool_file.display(),
            temp_target.display()
        )
    })?;
    fs::rename(&temp_target, target).with_context(|| {
        format!(
            "Falha ao finalizar escrita atomica {} -> {}",
            temp_target.display(),
            target.display()
        )
    })?;

    Ok(())
}

pub fn cleanup_task_cache(task_id: &str) -> Result<()> {
    let normalized_task_id = sanitize_task_id_for_fs(task_id);
    let target = transfer_cache_root().join(normalized_task_id.as_str());
    if target.exists() {
        fs::remove_dir_all(&target).with_context(|| {
            format!(
                "Falha ao limpar cache de transferencia {}",
                target.display()
            )
        })?;
    }
    Ok(())
}

pub fn cleanup_cache(max_age: Duration, max_total_bytes: u64) -> Result<()> {
    let root = transfer_cache_root();
    if !root.exists() {
        return Ok(());
    }

    let mut entries = Vec::new();
    for entry in fs::read_dir(&root)? {
        let entry = entry?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let metadata = fs::metadata(&path)?;
        let modified = metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        let age = SystemTime::now()
            .duration_since(modified)
            .unwrap_or(Duration::from_secs(0));
        let size = dir_size(&path)?;
        entries.push((path, age, size, modified));
    }

    for (path, age, _size, _modified) in &entries {
        if *age > max_age {
            let _ = fs::remove_dir_all(path);
        }
    }

    let mut remaining: Vec<(PathBuf, u64, SystemTime)> = entries
        .into_iter()
        .filter_map(|(path, age, size, modified)| {
            if age > max_age || !path.exists() {
                None
            } else {
                Some((path, size, modified))
            }
        })
        .collect();

    let mut total: u64 = remaining.iter().map(|(_, size, _)| *size).sum();
    if total <= max_total_bytes {
        return Ok(());
    }

    remaining.sort_by_key(|(_, _, modified)| *modified);
    for (path, size, _) in remaining {
        if total <= max_total_bytes {
            break;
        }
        if path.exists() {
            let _ = fs::remove_dir_all(&path);
        }
        total = total.saturating_sub(size);
    }

    Ok(())
}

fn dir_size(path: &Path) -> Result<u64> {
    let mut total = 0u64;
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        let metadata = fs::metadata(entry.path())?;
        if metadata.is_dir() {
            total = total.saturating_add(dir_size(&entry.path())?);
        } else {
            total = total.saturating_add(metadata.len());
        }
    }
    Ok(total)
}

#[cfg(test)]
mod tests {
    use super::sanitize_task_id_for_fs;

    #[test]
    fn should_sanitize_task_ids_for_windows_paths() {
        let value = sanitize_task_id_for_fs("transfer:1775267467973:904b52");
        assert_eq!(value, "transfer_1775267467973_904b52");
    }
}
