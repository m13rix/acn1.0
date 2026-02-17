import {
	AbsoluteFill,
	interpolate,
	useCurrentFrame,
	useVideoConfig,
	Img,
	staticFile,
	Audio,
} from 'remotion';
import {Video} from '@remotion/media';
import React from 'react';

export const Shot38: React.FC = () => {
	const frame = useCurrentFrame();
	const {durationInFrames} = useVideoConfig();

	// Timeline scaling: 7.97s total
	// Original landmarks: 0-3s, 3-6s, 6-10s -> Proportionally mapped
	const seg1End = Math.round((3 / 10) * durationInFrames);
	const seg2End = Math.round((6 / 10) * durationInFrames);

	// Intensifying Film Grain
	const grainOpacity = interpolate(frame, [0, durationInFrames], [0.15, 0.6], {
		extrapolateRight: 'clamp',
	});

	return (
		<AbsoluteFill style={{backgroundColor: 'black'}}>
			{/* Quick Cuts Sequence */}
			{frame < seg1End && (
				<AbsoluteFill>
					<Img
						src={staticFile('wedding_rings.png')}
						style={{
							width: '100%',
							height: '100%',
							objectFit: 'cover',
						}}
					/>
				</AbsoluteFill>
			)}

			{frame >= seg1End && frame < seg2End && (
				<AbsoluteFill>
					<Img
						src={staticFile('empty_courtroom_stock.png')}
						style={{
							width: '100%',
							height: '100%',
							objectFit: 'cover',
						}}
					/>
				</AbsoluteFill>
			)}

			{frame >= seg2End && (
				<AbsoluteFill>
					<Img
						src={staticFile('wedding_fade_dust.png')}
						style={{
							width: '100%',
							height: '100%',
							objectFit: 'cover',
						}}
					/>
				</AbsoluteFill>
			)}

			{/* Intensifying Film Grain Overlay */}
			<AbsoluteFill style={{opacity: grainOpacity, pointerEvents: 'none'}}>
				<Video
					src={staticFile('film_grain.mp4')}
					style={{
						width: '100%',
						height: '100%',
						objectFit: 'cover',
					}}
					muted
					loop
				/>
			</AbsoluteFill>

			{/* Dramatic Contrast increase over time */}
			<AbsoluteFill
				style={{
					backgroundColor: 'rgba(0,0,0,0.2)',
					opacity: interpolate(frame, [0, durationInFrames], [0, 0.4]),
					mixBlendMode: 'multiply',
					pointerEvents: 'none',
				}}
			/>

			<Audio src={staticFile('shot38_voice.mp3')} />
		</AbsoluteFill>
	);
};
