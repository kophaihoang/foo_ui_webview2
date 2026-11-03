# foo_dsp_automix

DSP cho foobar2000 v2 (x64): crossfade khi chuyển bài.

- Crossfade: vài giây cuối bài cũ nhỏ dần chồng lên vài giây đầu bài mới to dần, bỏ im lặng ở hai đầu. Chỉ dùng âm thanh đang phát (giữ lại đuôi bài cũ), không đọc trước bài kế.
- Đã bỏ khớp nhịp (gây khựng); bản khớp nhịp nằm trong lịch sử git của nhánh này.

Cài: lấy `foo_dsp_automix.fb2k-component` ở nhánh `automix-dll`, rồi Preferences → Components → Install.
Bật: Preferences → Playback → DSP Manager, đưa "AutoMix" lên đầu cột Active.
Chỉnh: Preferences → Advanced → Playback → AutoMix.

Build: `automix/foo_dsp_automix.sln` (không cần thư viện ngoài).

Giấy phép: GPL-3.0-or-later.
