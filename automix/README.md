# foo_dsp_automix

DSP cho foobar2000 v2 (x64): chuyển bài kiểu DJ.

- Chặng 1 (bản này): chồng đuôi bài cũ với đầu bài mới, crossfade cân công suất, cắt dần bass bài cũ, bỏ im lặng ở hai đầu.
- Chặng 2 (chưa làm): dò BPM và phách, khớp nhịp, EQ kiểu DJ.

Cài: lấy `foo_dsp_automix.fb2k-component` ở nhánh `automix-dll`, rồi Preferences → Components → Install.
Bật: Preferences → Playback → DSP Manager, đưa "AutoMix" lên đầu cột Active.
Chỉnh: Preferences → Advanced → Playback → AutoMix.
Nhật ký mỗi lần chuyển: View → Console, dòng bắt đầu bằng "AutoMix:".

Giấy phép: GPL-3.0-or-later.
