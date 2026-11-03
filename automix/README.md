# foo_dsp_automix

DSP cho foobar2000 v2 (x64): fade out / fade in khi chuyển bài.

- Fade out cuối bài (tính cả im lặng cuối) và fade in đầu bài kế khi bài tự chuyển. Chỉ chỉnh âm lượng, không đệm hay bỏ mẫu nào nên không gây khựng.
- Đã bỏ khớp nhịp (gây khựng); bản khớp nhịp nằm trong lịch sử git của nhánh này.

Cài: lấy `foo_dsp_automix.fb2k-component` ở nhánh `automix-dll`, rồi Preferences → Components → Install.
Bật: Preferences → Playback → DSP Manager, đưa "AutoMix" lên đầu cột Active.
Chỉnh: Preferences → Advanced → Playback → AutoMix.

Build: `automix/foo_dsp_automix.sln` (không cần thư viện ngoài).

Giấy phép: GPL-3.0-or-later.
