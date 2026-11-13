//! 设备身份：Ed25519 私钥 + 自签 clientAuth 证书（`docs/tcp-tls-ed25519.md` §11.4）。
//!
//! 桌面端**默认不打包服务端**，因此身份必须在本机自签，不能依赖内置 sidecar：
//! 用 rcgen（ring 后端，支持 Ed25519）生成密钥与证书；Rust 侧同时负责计算 SPKI
//! 指纹（与服务端 `server.SPKIFingerprint` 逐字节一致）。

use std::io::Write;
use std::path::{Path, PathBuf};

use base64::Engine;
use rcgen::{
    date_time_ymd, CertificateParams, DistinguishedName, DnType, ExtendedKeyUsagePurpose, IsCa,
    KeyPair, KeyUsagePurpose, PKCS_ED25519,
};
use sha2::{Digest, Sha256};

use crate::common::config;
use crate::common::error::AppError;

const DEVICE_KEY_FILE: &str = "device.key";
const DEVICE_CERT_FILE: &str = "device.crt";

/// 本机设备身份（DER 字节 + SPKI 指纹）
#[derive(Clone, Debug)]
pub struct DeviceIdentity {
    /// PKCS#8 DER 私钥
    pub key_pkcs8: Vec<u8>,
    /// X.509 DER 客户端证书（EKU=clientAuth）
    pub cert_der: Vec<u8>,
    /// `sha256:<base64url-nopad>`，用于在服务端 `pair --approve`
    pub fingerprint: String,
}

/// 设备身份目录：`<app_data>/device/`
pub fn device_dir(app: &tauri::AppHandle) -> Result<PathBuf, AppError> {
    Ok(config::get_data_dir(Some(app))?.join("device"))
}

/// 读取已有身份；文件缺失或解析失败时报错（不隐式生成，避免静默换身份）。
pub fn load(dir: &Path) -> Result<DeviceIdentity, AppError> {
    let key_path = dir.join(DEVICE_KEY_FILE);
    let cert_path = dir.join(DEVICE_CERT_FILE);
    if !key_path.exists() || !cert_path.exists() {
        return Err(AppError::msg(format!(
            "本机尚未生成设备身份（缺少 {} 或 {}）",
            key_path.display(),
            cert_path.display()
        )));
    }
    let key_pkcs8 = std::fs::read(&key_path)
        .map_err(|e| format!("读取设备私钥失败: {} ({})", e, key_path.display()))?;
    let cert_der = std::fs::read(&cert_path)
        .map_err(|e| format!("读取设备证书失败: {} ({})", e, cert_path.display()))?;
    let fingerprint = spki_fingerprint(&cert_der)?;
    Ok(DeviceIdentity { key_pkcs8, cert_der, fingerprint })
}

/// 生成身份（幂等）：已存在则直接读取；否则在本机自签 Ed25519 密钥与客户端证书。
pub fn ensure(dir: &Path, name: &str) -> Result<DeviceIdentity, AppError> {
    if dir.join(DEVICE_KEY_FILE).exists() && dir.join(DEVICE_CERT_FILE).exists() {
        return load(dir);
    }
    generate(dir, name)
}

/// 自签一对密钥/证书并落盘。私钥 0600、证书 0644。
pub fn generate(dir: &Path, name: &str) -> Result<DeviceIdentity, AppError> {
    std::fs::create_dir_all(dir)
        .map_err(|e| format!("创建设备身份目录失败: {} ({})", e, dir.display()))?;

    let key_pair = KeyPair::generate_for(&PKCS_ED25519)
        .map_err(|e| format!("生成 Ed25519 密钥失败: {}", e))?;

    let mut params = CertificateParams::new(Vec::new())
        .map_err(|e| format!("初始化证书参数失败: {}", e))?;
    let mut dn = DistinguishedName::new();
    dn.push(DnType::CommonName, if name.trim().is_empty() { "tigerAgent-client" } else { name });
    params.distinguished_name = dn;
    params.is_ca = IsCa::NoCa;
    params.key_usages = vec![KeyUsagePurpose::DigitalSignature];
    params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ClientAuth];
    // 固定有效期窗口（2020–2040）：服务端只校验 Ed25519 公钥 + EKU + 白名单，
    // 不校验客户端证书日期，因此不需要依赖系统时钟求 now。
    params.not_before = date_time_ymd(2020, 1, 1);
    params.not_after = date_time_ymd(2040, 1, 1);

    let cert = params
        .self_signed(&key_pair)
        .map_err(|e| format!("签发客户端证书失败: {}", e))?;
    let key_pkcs8 = key_pair.serialize_der();
    let cert_der = cert.der().to_vec();

    let key_path = dir.join(DEVICE_KEY_FILE);
    let cert_path = dir.join(DEVICE_CERT_FILE);
    write_private_file(&key_path, &key_pkcs8)?;
    std::fs::write(&cert_path, &cert_der)
        .map_err(|e| format!("写入设备证书失败: {} ({})", e, cert_path.display()))?;

    let fingerprint = spki_fingerprint(&cert_der)?;
    Ok(DeviceIdentity { key_pkcs8, cert_der, fingerprint })
}

fn write_private_file(path: &Path, bytes: &[u8]) -> Result<(), AppError> {
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut file = opts
        .open(path)
        .map_err(|e| format!("写入设备私钥失败: {} ({})", e, path.display()))?;
    file.write_all(bytes)
        .map_err(|e| format!("写入设备私钥失败: {} ({})", e, path.display()))?;
    drop(file);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// `sha256:<base64url_nopad>` over the certificate's SubjectPublicKeyInfo.
///
/// 必须与服务端 `server.SPKIFingerprint` 相同：用 SPKI 而不是整张证书，
/// 这样“换证不换钥”时指纹不变，客户端不需要重新配对。
pub fn spki_fingerprint(cert_der: &[u8]) -> Result<String, AppError> {
    let (_, cert) = x509_parser::parse_x509_certificate(cert_der)
        .map_err(|e| format!("解析证书失败: {}", e))?;
    let spki = cert.tbs_certificate.subject_pki.raw;
    let digest = Sha256::digest(spki);
    Ok(format!(
        "sha256:{}",
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest)
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generates_stable_loadable_identity() {
        let dir = std::env::temp_dir().join(format!("adm-device-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let first = ensure(&dir, "laptop").expect("generate");
        let second = load(&dir).expect("load");
        assert_eq!(first.fingerprint, second.fingerprint);
        assert_eq!(first.key_pkcs8, second.key_pkcs8);
        assert!(first.fingerprint.starts_with("sha256:"));
        assert_eq!(first.fingerprint.len(), "sha256:".len() + 43);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
