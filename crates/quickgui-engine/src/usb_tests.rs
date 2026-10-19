use super::*;
use crate::{flow_v4, Engine, Project};

#[test]
fn discovery_identity_preserves_non_utf8_paths_interfaces_and_generations() {
    let device = DeviceInfo {
        id: usb_comm::DeviceId {
            endpoint: DevicePath::Hid(vec![0xff, 0, 0x80]),
            generation: 7,
        },
        transport: Transport::Hid,
        bus: Bus::Usb,
        vendor_id: Some(1),
        product_id: Some(2),
        serial_number: None,
        manufacturer: None,
        product: None,
        hid: Some(usb_comm::HidInfo {
            interface_number: Some(2),
            usage_page: 0xff00,
            usage: 1,
        }),
        usb_print: None,
    };
    let v = device_json(&device);
    assert_eq!(v["path"]["bytes"], json!([255, 0, 128]));
    let mut replugged = device.clone();
    replugged.id.generation += 1;
    assert_ne!(identity(&device), identity(&replugged));
    assert_eq!(v["hid"]["interfaceNumber"], 2);
    assert!(Filter {
        vendor_id: Some(1),
        product_id: Some(2),
        ..Default::default()
    }
    .native()
    .unwrap()
    .matches(&device));
    assert!(!Filter {
        vendor_id: Some(2),
        ..Default::default()
    }
    .native()
    .unwrap()
    .matches(&device));
}

#[tokio::test]
async fn real_manager_discovery_watch_can_be_stopped_and_invalidates_queued_events() {
    let lifetime = CancellationToken::new();
    let service = UsbService::new(lifetime.clone());
    let result = service
        .discover("flow", "discover", "watch", Filter::default())
        .await
        .unwrap();
    assert!(result["devices"].is_array());
    let cancel = CancellationToken::new();
    let event = tokio::time::timeout(
        std::time::Duration::from_secs(15),
        service.next_event(&cancel),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(service.current(&event));
    service
        .discover("flow", "discover", "unwatch", Filter::default())
        .await
        .unwrap();
    assert!(!service.current(&event));
    service.reset().await;
    lifetime.cancel();
}

#[tokio::test]
async fn revision_reset_does_not_wait_for_an_idle_event_consumer() {
    let lifetime = CancellationToken::new();
    let service = UsbService::new(lifetime.clone());
    let subscriber = service.clone();
    let cancel = lifetime.clone();
    let receive = tokio::spawn(async move { subscriber.next_event(&cancel).await });
    tokio::task::yield_now().await;
    tokio::time::timeout(std::time::Duration::from_secs(1), service.reset())
        .await
        .expect("an idle receiver must not block revision cleanup");
    lifetime.cancel();
    assert!(receive.await.unwrap().is_none());
}

#[tokio::test]
async fn multiple_command_entries_and_async_outputs_share_the_same_fb_contract() {
    let mut raw: Value =
        serde_json::from_str(include_str!("../tests/fixtures/function-blocks.json")).unwrap();
    raw["flows"] = json!([{"id":"usb","name":"USB","enabled":true,"nodes":[
        {"id":"a","kind":"event","label":"a","config":{"trigger":"manual"}},
        {"id":"b","kind":"event","label":"b","config":{"trigger":"manual"}},
        {"id":"io","kind":"usb","label":"USB","config":{"action":"communicate","sessionId":"test","device":{"source":"literal","value":null},"options":{"source":"literal","value":{}},"data":{"source":"literal","value":"00"},"encoding":{"source":"literal","value":"hex"},"reportId":{"source":"literal","value":0},"length":{"source":"literal","value":64}},"block":{"version":1,"inputs":[],"outputs":[{"id":"q","name":"Q","type":"json","path":["result"]}]}},
        {"id":"done","kind":"write","label":"done","config":{"variable":"done"}},
        {"id":"error","kind":"write","label":"error","config":{"variable":"error"}},
        {"id":"rx","kind":"write","label":"rx","config":{"variable":"rx"}}
    ],"edges":[
        {"id":"close","source":"a","target":"io","targetHandle":"close"},
        {"id":"send","source":"b","target":"io","targetHandle":"send"},
        {"id":"done","source":"io","target":"done","sourceHandle":"success"},
        {"id":"error","source":"io","target":"error","sourceHandle":"error"},
        {"id":"rx","source":"io","target":"rx","sourceHandle":"rx"}
    ]}]);
    raw["variables"] = json!([{"id":"done","name":"done","type":"json","initial":null},{"id":"error","name":"error","type":"json","initial":null},{"id":"rx","name":"rx","type":"json","initial":null}]);
    let project: Project = serde_json::from_value(raw).unwrap();
    let engine = Arc::new(Mutex::new(Engine::new(project).unwrap()));
    let lifetime = CancellationToken::new();
    let serial = crate::serial::SerialService::new(lifetime.clone());
    let result = flow_v4::run_shared(
        engine.clone(),
        Some(serial.clone()),
        "usb",
        None,
        Value::Null,
        lifetime.child_token(),
        None,
    )
    .await
    .unwrap();
    assert_eq!(result.values["done"].value["status"], "closed");
    assert_eq!(result.values["error"].value["code"], "USB_ERROR");
    assert!(result.values["rx"].value.is_null());
    let packet = json!({"bytes":[1,2],"reportId":3});
    let result = flow_v4::run_output_shared(
        engine,
        Some(serial.clone()),
        "usb",
        "io",
        "rx",
        envelope(packet.clone(), "rx"),
        lifetime.child_token(),
        None,
    )
    .await
    .unwrap();
    assert_eq!(result.values["rx"].value, packet);
    serial.shutdown().await;
}
